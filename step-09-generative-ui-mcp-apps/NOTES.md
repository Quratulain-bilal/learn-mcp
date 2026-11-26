# Step 09 notes: generative UI with MCP Apps

## What I built

Three React widgets for the step 8 server, using only the standard MCP Apps APIs (`@modelcontextprotocol/ext-apps` 2.0.4), with nothing Claude- or ChatGPT-specific:

| Widget | Shown with | What it does |
| --- | --- | --- |
| **Orders table** (`ui://learn-mcp/orders-table-v1.html`) | `list_orders` | The page of orders. **Load more** calls `list_orders` from the widget with the same filters plus the cursor. **Lines** sends "Show me the lines of order …" to the model (`sendMessage`). |
| **Sales chart** (`ui://learn-mcp/sales-chart-v1.html`) | `get_sales_summary` | An SVG bar chart (no chart library). Bars at or above the company's sales threshold are highlighted. **By month / product / customer** re-call `get_sales_summary` from the widget. |
| **Order form** (`ui://learn-mcp/order-form-v1.html`) | `open_order_form` (new) | The company's customers and catalog in dropdowns. **Place order** calls `create_order` from the widget, then tells the model what happened with `updateModelContext`. |

## How it fits together

1. **Build:** `npm run build:widgets` runs Vite once per folder in `widgets/` with `vite-plugin-singlefile`. React, the ext-apps `App` class and the CSS are all inlined into one HTML file per widget, because the host's iframe CSP blocks loading scripts from anywhere. The script then writes `src/widgets/generated.ts` (git-ignored), which exports each widget's HTML as a string. `npm test`, `npm run dev`, `npm run deploy` and `npm run typecheck` rebuild it first.
2. **Resources:** `src/widgets/resources.ts` registers each widget with `registerAppResource` and the MIME type `text/html;profile=mcp-app`. The URI carries a version (`-v1`) because hosts cache UI resources. The CSP declares no outside origins.
3. **Tools:** `list_orders`, `get_sales_summary` and `open_order_form` are registered with `registerAppTool`, which is `registerTool` plus `_meta.ui.resourceUri` (and the older `ui/resourceUri` key). The handlers are unchanged: they still return a text answer and `structuredContent`. Hosts without MCP Apps simply show the text (tested).
4. **Widget runtime** (`widgets/shared/useWidget.ts`):
   - `useApp` connects to the host, and the `ontoolinput` and `ontoolresult` handlers are set before the handshake;
   - `useHostStyles` takes the host's CSS variables and fonts;
   - the widget follows the host's light or dark theme;
   - `autoResize` keeps the iframe as tall as the content;
   - `callTool()` wraps `app.callServerTool`.

## Letting the model choose

The tool descriptions say which screen each one shows and when to use it:

- `list_orders`: "Show the company's orders as an interactive **TABLE**… when the user wants to see, browse or find orders."
- `get_sales_summary`: "Show the company's sales totals as a bar **CHART**… for trends, comparisons and 'how are we doing' questions."
- `open_order_form`: "Show an interactive **ORDER FORM**… when the user wants to create an order but hasn't given every detail… If they gave all the details, call `create_order` directly."

This is the first rung of book lesson 20.10's ladder: the model picks **one fixed screen** per request and fills it with data. Step 19 lets it compose a screen from approved parts.

Prompts that should each produce a different widget:

1. "Show me Ayesha Khan's orders." → orders table
2. "How did our sales go month by month in 2025?" → sales chart (then click **By product**)
3. "I want to enter a new order." → order form
4. "Create an order for laura.schmidt@example.com: 2 Desk Lamps." → no form; the model calls `create_order` directly

## Tenant isolation

The widget HTML is the same for every company and contains no data. Data arrives only through tool results, and every call a widget makes (`list_orders`, `get_sales_summary`, `create_order`) goes through the host over the same authenticated MCP connection. So it passes the same token check, membership re-check and `forTenant`/RLS as any other call. The widget never sees a token or a company id. Tested: `open_order_form` lists only the caller's company's customers and products.

## Things I learned the hard way

- **Forms in a sandbox:** a host may sandbox the iframe without `allow-forms`, which silently blocks `<form>` submission, so the button did nothing in my preview. The order form now uses a plain `<div role="form">` and a button `onClick`.
- **Backgrounds:** the widget must paint its own background (`var(--w-bg)`). With a transparent body, dark text on a dark host page was invisible.
- **Peer dependency:** `@modelcontextprotocol/client` is needed in the widget build, matching the server SDK's version (2.4.0).
- **Size:** about 450 KB per widget, about 127 KB gzipped, mostly React plus the MCP SDK and its schemas. The host fetches it once per conversation. If it matters later, Preact's React-compatible build would cut about 100 KB.

## Local preview

`npm run preview:widgets` builds the widgets and opens a local stand-in for the chat host (`preview/`). It renders a widget in a sandboxed iframe, connects with the SDK's own `AppBridge` (the host side of MCP Apps), sends a sample tool input and result, and logs every `callServerTool`, `sendMessage` and `updateModelContext`. Use `?widget=sales-chart&theme=dark` to open one directly. I checked all three widgets with it, in light and dark: the table's Load more, the chart's regrouping, and placing an order from the form. It uses sample data, not the server.

## Databases

Step 9 adds no migrations, so it **shares step 8's databases and Hyperdrive configs** (`step08`, `step08_tenant_enterprise`). That keeps the number of Hyperdrive configs down on the free plan. Step 8 can't break, because step 9 changes no tables. It has its own KV namespace.

## Test checklist for Claude and ChatGPT

| Check | Claude (web, Desktop) | ChatGPT (dev mode) |
| --- | --- | --- |
| Each prompt above shows the right widget | | needs a paid ChatGPT plan |
| Light and dark theme follow the host | | |
| Load more, regroup, place order (tool callbacks) | | |
| A member placing an order works; an error (e.g. no customers) shows in red | | |
| Text answer still makes sense if the widget doesn't render | | |

Claude Desktop caches UI resources: after a widget change, bump `VERSION` in `src/widgets/resources.ts` (or fully quit and relaunch Desktop).
