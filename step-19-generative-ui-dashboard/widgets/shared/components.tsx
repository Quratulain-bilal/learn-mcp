import { formatMoney } from "./useWidget";

/**
 * THE WIDGET LIBRARY: small, reviewed components with consistent props and theming
 * (every colour comes from widget.css, which follows the host). Widgets are built from
 * these; the dashboard widget composes them from the blocks the model chose.
 *
 * All text is rendered by React, which escapes it: a customer called "<script>" shows up
 * as text, never as markup (step 16, untrusted data).
 */

export const METRIC_LABELS: Record<string, string> = {
  revenue: "Revenue",
  orders: "Orders",
  average_order_value: "Average order",
  customers: "Customers",
  top_product: "Top product",
  top_customer: "Top customer",
};
const MONEY = new Set(["revenue", "average_order_value"]);

export interface KpiCard {
  metric: string;
  value: number | string | null;
  previous: number | string | null;
}

/** A row of headline numbers, each with its change against the previous period if given. */
export function KpiCards({ cards, currency }: { cards: KpiCard[]; currency: string }) {
  return (
    <div className="kpis" role="list">
      {cards.map((c) => {
        const money = MONEY.has(c.metric);
        const shown =
          c.value === null ? "—" : typeof c.value === "number" ? (money ? formatMoney(c.value, currency) : c.value.toLocaleString()) : c.value;
        const change =
          typeof c.value === "number" && typeof c.previous === "number" && c.previous !== 0
            ? Math.round(((c.value - c.previous) / c.previous) * 1000) / 10
            : null;
        return (
          <div className="kpi" role="listitem" key={c.metric}>
            <div className="kpi-label">{METRIC_LABELS[c.metric] ?? c.metric}</div>
            <div className="kpi-value">{shown}</div>
            {change !== null && (
              <div className={change >= 0 ? "kpi-change ok" : "kpi-change error"}>
                {change >= 0 ? "▲" : "▼"} {Math.abs(change)}% vs previous
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export interface Bar {
  label: string;
  revenue: number;
  orders?: number;
  highlight?: boolean;
}

/** Horizontal revenue bars (SVG, no chart library). Highlighted bars use the accent colour. */
export function BarChart({ bars, currency, ariaLabel }: { bars: Bar[]; currency: string; ariaLabel: string }) {
  if (bars.length === 0) return <p className="muted">No sales in this range.</p>;
  const max = Math.max(1, ...bars.map((b) => b.revenue));
  const barHeight = 22;
  const gap = 6;
  const labelWidth = 150;
  const width = 560;
  const height = bars.length * (barHeight + gap);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={ariaLabel} style={{ display: "block" }}>
      {bars.map((b, i) => {
        const w = ((width - labelWidth - 90) * b.revenue) / max;
        const y = i * (barHeight + gap);
        return (
          <g key={`${b.label}-${i}`}>
            <title>{`${b.label}: ${formatMoney(b.revenue, currency)}${b.orders !== undefined ? `, ${b.orders} orders` : ""}`}</title>
            <text x={labelWidth - 8} y={y + barHeight * 0.68} textAnchor="end" fontSize="12" fill="var(--w-text)">
              {b.label.length > 22 ? `${b.label.slice(0, 21)}…` : b.label}
            </text>
            <rect
              x={labelWidth}
              y={y}
              width={Math.max(2, w)}
              height={barHeight}
              rx="3"
              fill={b.highlight ? "var(--w-accent)" : "var(--w-text-2)"}
              opacity={b.highlight ? 1 : 0.55}
            />
            <text x={labelWidth + w + 6} y={y + barHeight * 0.68} fontSize="12" fill="var(--w-text-2)">
              {formatMoney(b.revenue, currency)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export interface OrderRow {
  order_ref: string;
  order_date: string;
  customer: string;
  total: number;
}

/** A compact table of orders. */
export function OrdersTableView({ orders, currency }: { orders: OrderRow[]; currency?: string }) {
  if (orders.length === 0) return <p className="muted">No orders match.</p>;
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">Order</th>
            <th scope="col">Date</th>
            <th scope="col">Customer</th>
            <th scope="col" className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.order_ref}>
              <td>{o.order_ref}</td>
              <td>{o.order_date}</td>
              <td>{o.customer}</td>
              <td className="num">{formatMoney(o.total, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface ReportSummary {
  year: number;
  orders: number;
  revenue: number;
  topProducts: { product: string; revenue: number }[];
  topCustomers: { customer: string; revenue: number }[];
}

/** A saved yearly report: headline plus its top products. */
export function ReportView({ report, stage, currency }: { report: ReportSummary; stage: string; currency: string }) {
  return (
    <div>
      <p>
        <strong>{formatMoney(report.revenue, currency)}</strong> from {report.orders} orders in {report.year}{" "}
        <span className="muted">({stage.replace("_", " ")})</span>
      </p>
      <BarChart
        bars={report.topProducts.map((p) => ({ label: p.product, revenue: p.revenue }))}
        currency={currency}
        ariaLabel={`Top products in ${report.year}`}
      />
    </div>
  );
}
