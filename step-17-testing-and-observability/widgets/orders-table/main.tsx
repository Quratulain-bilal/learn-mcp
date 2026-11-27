import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "../shared/widget.css";
import { callTool, formatMoney, useWidget } from "../shared/useWidget";

/**
 * ORDERS TABLE, shown with list_orders. The first page arrives with the tool result;
 * "Load more" calls list_orders again FROM THE WIDGET (through the host, with the same
 * filters and the cursor), and "Show lines" asks the model about one order.
 */

interface Order {
  order_ref: string;
  order_date: string;
  customer: string;
  city: string;
  lines: number;
  total: number;
}
interface Page {
  orders: Order[];
  nextCursor: string | null;
}

function OrdersTable() {
  const { app, input, data, setData, error } = useWidget<Page>("OrdersTable");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  if (error) return <p className="widget error">{error}</p>;
  if (!data) return <p className="widget muted">Loading orders…</p>;

  const filters = ["from", "to", "customer", "product"]
    .filter((k) => input[k])
    .map((k) => `${k}: ${String(input[k])}`)
    .join(" · ");

  async function loadMore() {
    if (!app || !data?.nextCursor) return;
    setLoading(true);
    setLoadError(null);
    try {
      // Same filters as the model used, plus the cursor for the next page.
      const next = await callTool<Page>(app, "list_orders", { ...input, cursor: data.nextCursor });
      setData({ orders: [...data.orders, ...next.orders], nextCursor: next.nextCursor });
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function showLines(ref: string) {
    // Hands the next step back to the model, as if the user had typed it.
    void app?.sendMessage({ role: "user", content: [{ type: "text", text: `Show me the lines of order ${ref}.` }] });
  }

  return (
    <div className="widget">
      <h1>Orders</h1>
      <p className="sub">
        {data.orders.length} shown{filters ? ` · ${filters}` : ""}
      </p>
      {data.orders.length === 0 ? (
        <p className="muted">No orders match these filters.</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">Date</th>
                <th scope="col">Customer</th>
                <th scope="col" className="num">Lines</th>
                <th scope="col" className="num">Total</th>
                <th scope="col"><span className="muted">Details</span></th>
              </tr>
            </thead>
            <tbody>
              {data.orders.map((o) => (
                <tr key={o.order_ref}>
                  <td>{o.order_ref}</td>
                  <td>{o.order_date}</td>
                  <td>
                    {o.customer}
                    <div className="muted">{o.city}</div>
                  </td>
                  <td className="num">{o.lines}</td>
                  <td className="num">{formatMoney(o.total)}</td>
                  <td>
                    <button onClick={() => showLines(o.order_ref)} aria-label={`Show lines of ${o.order_ref}`}>
                      Lines
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="footer">
        <span className="muted">{data.nextCursor ? "More orders available." : "That's all of them."}</span>
        {data.nextCursor && (
          <button onClick={loadMore} disabled={loading}>
            {loading ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
      {loadError && <p className="error">{loadError}</p>}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <OrdersTable />
  </StrictMode>,
);
