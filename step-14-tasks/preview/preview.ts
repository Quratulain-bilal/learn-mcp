/**
 * A LOCAL STAND-IN FOR THE CHAT HOST, for looking at widgets in a normal browser:
 *   npm run preview:widgets   (then open the URL it prints)
 *
 * It does what Claude or ChatGPT does: renders the built widget HTML in a sandboxed
 * iframe, connects to it with the SDK's AppBridge (the host side of MCP Apps), sends the
 * tool input and result, and answers the widget's tool calls, here with SAMPLE data, not
 * the real server. Real testing still happens in Claude and ChatGPT.
 */
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { WIDGET_HTML } from "../src/widgets/generated";
import { SAMPLE_CALLS, SAMPLE_RESULTS } from "./samples";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const log = (line: string) => ($("log").textContent = `${line}\n${$("log").textContent}`);

async function load() {
  const widget = $<HTMLSelectElement>("widget").value as keyof typeof WIDGET_HTML;
  const theme = $<HTMLSelectElement>("theme").value as "light" | "dark";
  document.body.className = theme;
  const fresh = $<HTMLIFrameElement>("frame");
  fresh.srcdoc = WIDGET_HTML[widget];
  await new Promise((r) => fresh.addEventListener("load", r, { once: true }));

  const bridge = new AppBridge(
    null,
    { name: "widget-preview", version: "1.0.0" },
    { serverTools: {}, openLinks: {}, logging: {}, message: { text: {} }, updateModelContext: { text: {} } },
    { hostContext: { theme, displayMode: "inline" } },
  );
  bridge.onsizechange = ({ height }) => {
    if (height) fresh.style.height = `${height}px`;
  };
  bridge.oncalltool = async (params) => {
    log(`callServerTool ${params.name} ${JSON.stringify(params.arguments)}`);
    return SAMPLE_CALLS(params.name, params.arguments ?? {});
  };
  bridge.onmessage = async (params) => {
    log(`sendMessage ${JSON.stringify(params.content)}`);
    return {};
  };
  bridge.onupdatemodelcontext = async (params) => {
    log(`updateModelContext ${JSON.stringify(params.content)}`);
    return {};
  };
  bridge.oninitialized = async () => {
    const sample = SAMPLE_RESULTS[widget];
    await bridge.sendToolInput({ arguments: sample.input });
    await bridge.sendToolResult(sample.result);
  };
  await bridge.connect(new PostMessageTransport(fresh.contentWindow!, fresh.contentWindow!));
}

// ?widget=sales-chart&theme=dark opens a widget directly.
const params = new URLSearchParams(location.search);
if (params.get("widget")) $<HTMLSelectElement>("widget").value = params.get("widget")!;
if (params.get("theme")) $<HTMLSelectElement>("theme").value = params.get("theme")!;
// Each Load starts from a fresh page, so no bridge from an earlier widget is left listening.
$("load").addEventListener("click", () => {
  const next = new URLSearchParams({
    widget: $<HTMLSelectElement>("widget").value,
    theme: $<HTMLSelectElement>("theme").value,
  });
  location.search = next.toString();
});
void load();
