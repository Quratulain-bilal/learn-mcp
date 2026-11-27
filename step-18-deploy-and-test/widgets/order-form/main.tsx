import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "../shared/widget.css";
import { callTool, formatMoney, useWidget } from "../shared/useWidget";

/**
 * ORDER FORM, shown with open_order_form. The tool sends the company's customers and
 * catalog; the user picks a customer and products here, and "Place order" calls
 * create_order FROM THE WIDGET. The server validates everything again (customer and
 * products must be in the caller's company), so the form is a convenience, not a guard.
 */

interface Catalog {
  customers: { name: string; email: string; city: string }[];
  products: { name: string; category: string; list_price: number }[];
  currency: string;
}
interface Created {
  order_ref: string;
  order_date: string;
  customer: string;
  total: number;
}
interface Line {
  product: string;
  quantity: number;
}

function OrderForm() {
  const { app, data, error } = useWidget<Catalog>("OrderForm");
  const [customer, setCustomer] = useState("");
  const [lines, setLines] = useState<Line[]>([{ product: "", quantity: 1 }]);
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "done" | "error"; text?: string; order?: Created }>({
    kind: "idle",
  });

  if (error) return <p className="widget error">{error}</p>;
  if (!data) return <p className="widget muted">Loading the order form…</p>;

  const price = (name: string) => data.products.find((p) => p.name === name)?.list_price ?? 0;
  const chosen = lines.filter((l) => l.product);
  const total = chosen.reduce((sum, l) => sum + price(l.product) * l.quantity, 0);
  const duplicate = chosen.some((l, i) => chosen.findIndex((m) => m.product === l.product) !== i);
  const canSubmit = customer && chosen.length > 0 && !duplicate && status.kind !== "busy";

  const update = (i: number, patch: Partial<Line>) => setLines(lines.map((l, n) => (n === i ? { ...l, ...patch } : l)));

  async function submit() {
    if (!app || !canSubmit) return;
    setStatus({ kind: "busy" });
    try {
      const order = await callTool<Created>(app, "create_order", { customer_email: customer, items: chosen });
      setStatus({ kind: "done", order });
      // Let the model know, so the conversation reflects what happened in the widget.
      void app.updateModelContext({
        content: [{ type: "text", text: `The user placed order ${order.order_ref} for ${order.customer}, total ${order.total}.` }],
      });
    } catch (e) {
      setStatus({ kind: "error", text: (e as Error).message });
    }
  }

  if (status.kind === "done" && status.order) {
    const o = status.order;
    return (
      <div className="widget">
        <h1 className="ok">Order {o.order_ref} placed</h1>
        <p className="sub">
          {o.customer} · {o.order_date} · {formatMoney(o.total, data.currency)}
        </p>
        <button
          onClick={() => {
            setLines([{ product: "", quantity: 1 }]);
            setStatus({ kind: "idle" });
          }}
        >
          Place another order
        </button>
      </div>
    );
  }

  // A <div>, not a <form>: hosts may sandbox the iframe without "allow-forms", which
  // silently blocks form submission. A plain button click always works.
  return (
    <div className="widget" role="form" aria-label="New order">
      <h1>New order</h1>
      <p className="sub">Prices are today's catalog prices. Nothing is saved until you place the order.</p>

      <label htmlFor="customer">Customer</label>
      <select id="customer" value={customer} onChange={(e) => setCustomer(e.target.value)} required>
        <option value="">Choose a customer…</option>
        {data.customers.map((c) => (
          <option key={c.email} value={c.email}>
            {c.name} ({c.city})
          </option>
        ))}
      </select>

      <div style={{ marginTop: 12 }}>
        <label>Products</label>
        {lines.map((line, i) => (
          <div className="row" key={i} style={{ marginBottom: 6 }}>
            <select
              aria-label={`Product ${i + 1}`}
              value={line.product}
              onChange={(e) => update(i, { product: e.target.value })}
            >
              <option value="">Choose a product…</option>
              {data.products.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name} · {formatMoney(p.list_price, data.currency)}
                </option>
              ))}
            </select>
            <input
              aria-label={`Quantity ${i + 1}`}
              type="number"
              min={1}
              max={1000}
              value={line.quantity}
              onChange={(e) => update(i, { quantity: Math.min(1000, Math.max(1, Number(e.target.value) || 1)) })}
              style={{ width: 80 }}
            />
            <button
              type="button"
              onClick={() => setLines(lines.filter((_, n) => n !== i))}
              disabled={lines.length === 1}
              aria-label={`Remove product ${i + 1}`}
            >
              ✕
            </button>
          </div>
        ))}
        <button type="button" onClick={() => setLines([...lines, { product: "", quantity: 1 }])} disabled={lines.length >= 20}>
          Add product
        </button>
      </div>

      {duplicate && <p className="error">Each product can appear only once; change its quantity instead.</p>}
      <div className="footer">
        <strong>Total: {formatMoney(total, data.currency)}</strong>
        <button type="button" className="primary" disabled={!canSubmit} onClick={() => void submit()}>
          {status.kind === "busy" ? "Placing…" : "Place order"}
        </button>
      </div>
      {status.kind === "error" && <p className="error">{status.text}</p>}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <OrderForm />
  </StrictMode>,
);
