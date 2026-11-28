import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "../shared/widget.css";
import { BarChart } from "../shared/components";
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
      {/* The library's bar chart (widgets/shared/components.tsx), shared with the dashboard. */}
      <BarChart
        bars={data.groups.map((g) => ({
          label: label(g),
          revenue: Number(g.revenue),
          orders: Number(g.orders),
          highlight: g.at_or_above_threshold === true,
        }))}
        currency={data.currency}
        ariaLabel={`Bar chart of revenue by ${data.group_by}`}
      />
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
