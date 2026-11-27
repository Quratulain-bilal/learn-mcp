import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "../shared/widget.css";
import { callTool, formatMoney, useWidget } from "../shared/useWidget";

/**
 * SALES CHART, shown with get_sales_summary: one bar per month, product or customer.
 * Bars at or above the company's sales threshold (from its settings) are highlighted.
 * The buttons regroup the same date range by calling get_sales_summary from the widget.
 */

type GroupBy = "month" | "product" | "customer";
interface Summary {
  group_by: GroupBy;
  groups: Record<string, string | number | boolean | null>[];
  total: { orders: number; units: number; revenue: number };
  moreGroups: boolean;
  currency: string;
  threshold: number;
}

const GROUPINGS: GroupBy[] = ["month", "product", "customer"];

function SalesChart() {
  const { app, input, data, setData, error } = useWidget<Summary>("SalesChart");
  const [busy, setBusy] = useState(false);
  const [regroupError, setRegroupError] = useState<string | null>(null);

  if (error) return <p className="widget error">{error}</p>;
  if (!data) return <p className="widget muted">Loading sales…</p>;

  async function regroup(groupBy: GroupBy) {
    if (!app || !data || groupBy === data.group_by) return;
    setBusy(true);
    setRegroupError(null);
    try {
      setData(await callTool<Summary>(app, "get_sales_summary", { ...input, group_by: groupBy }));
    } catch (e) {
      setRegroupError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const label = (g: Summary["groups"][number]) => String(g[data.group_by] ?? "");
  const max = Math.max(1, ...data.groups.map((g) => Number(g.revenue)));
  const barHeight = 22;
  const gap = 6;
  const labelWidth = 150;
  const width = 560;
  const height = data.groups.length * (barHeight + gap);
  const range = [input.from, input.to].filter(Boolean).join(" to ");

  return (
    <div className="widget">
      <h1>Sales by {data.group_by}</h1>
      <p className="sub">
        {formatMoney(data.total.revenue, data.currency)} from {data.total.orders} orders ({data.total.units} units)
        {range ? ` · ${range}` : ""}
      </p>
      <div className="toolbar" role="group" aria-label="Group sales by">
        {GROUPINGS.map((g) => (
          <button key={g} aria-pressed={g === data.group_by} onClick={() => regroup(g)} disabled={busy}>
            By {g}
          </button>
        ))}
      </div>
      {data.groups.length === 0 ? (
        <p className="muted">No sales in this range.</p>
      ) : (
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          role="img"
          aria-label={`Bar chart of revenue by ${data.group_by}`}
          style={{ display: "block" }}
        >
          {data.groups.map((g, i) => {
            const revenue = Number(g.revenue);
            const w = ((width - labelWidth - 90) * revenue) / max;
            const y = i * (barHeight + gap);
            const hot = g.at_or_above_threshold === true;
            return (
              <g key={label(g)}>
                <title>{`${label(g)}: ${formatMoney(revenue, data.currency)}, ${g.orders} orders`}</title>
                <text x={labelWidth - 8} y={y + barHeight * 0.68} textAnchor="end" fontSize="12" fill="var(--w-text)">
                  {label(g).length > 22 ? `${label(g).slice(0, 21)}…` : label(g)}
                </text>
                <rect
                  x={labelWidth}
                  y={y}
                  width={Math.max(2, w)}
                  height={barHeight}
                  rx="3"
                  fill={hot ? "var(--w-accent)" : "var(--w-text-2)"}
                  opacity={hot ? 1 : 0.55}
                />
                <text x={labelWidth + w + 6} y={y + barHeight * 0.68} fontSize="12" fill="var(--w-text-2)">
                  {formatMoney(revenue, data.currency)}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      <p className="sub" style={{ marginTop: 8 }}>
        Highlighted: at or above your company's threshold of {formatMoney(data.threshold, data.currency)}.
        {data.moreGroups ? " Only the largest groups are shown." : ""}
      </p>
      {regroupError && <p className="error">{regroupError}</p>}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SalesChart />
  </StrictMode>,
);
