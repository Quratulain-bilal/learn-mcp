import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../shared/widget.css";
import {
  BarChart,
  type KpiCard,
  KpiCards,
  type OrderRow,
  OrdersTableView,
  type ReportSummary,
  ReportView,
} from "../shared/components";
import { useWidget } from "../shared/useWidget";

/**
 * THE DASHBOARD, shown with show_dashboard. The model chose the blocks; the server
 * checked them and filled them with the company's data; this widget only RENDERS them,
 * each with its component from the library. An unknown block type is skipped, never
 * rendered as raw data.
 */

type Range = { from: string | null; to: string | null };
type Block =
  | { type: "kpi"; range: Range; currency: string; cards: KpiCard[] }
  | { type: "chart"; group_by: string; range: Range; currency: string; threshold: number; groups: { label: string; orders: number; revenue: number }[] }
  | { type: "table"; currency: string; filters: { customer: string | null; product: string | null }; orders: OrderRow[] }
  | { type: "report"; year: number; currency: string; report: { report_id: string; stage: string; summary: ReportSummary } | null };

interface Dashboard {
  title: string;
  blocks: Block[];
}

const rangeText = (r: Range) => (r.from || r.to ? ` · ${r.from ?? "start"} to ${r.to ?? "today"}` : "");

function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case "kpi":
      return (
        <section className="block" aria-label="Headline numbers">
          {(block.range.from || block.range.to) && <h2>Headline{rangeText(block.range)}</h2>}
          <KpiCards cards={block.cards} currency={block.currency} />
        </section>
      );
    case "chart":
      return (
        <section className="block">
          <h2>
            Revenue by {block.group_by}
            {rangeText(block.range)}
          </h2>
          <BarChart
            bars={block.groups.map((g) => ({ ...g, highlight: g.revenue >= block.threshold }))}
            currency={block.currency}
            ariaLabel={`Revenue by ${block.group_by}`}
          />
        </section>
      );
    case "table":
      return (
        <section className="block">
          <h2>
            Recent orders
            {block.filters.customer ? ` · customer: ${block.filters.customer}` : ""}
            {block.filters.product ? ` · product: ${block.filters.product}` : ""}
          </h2>
          <OrdersTableView orders={block.orders} currency={block.currency} />
        </section>
      );
    case "report":
      return (
        <section className="block">
          <h2>{block.year} report</h2>
          {block.report ? (
            <ReportView report={block.report.summary} stage={block.report.stage} currency={block.currency} />
          ) : (
            <p className="muted">No saved report for {block.year} yet. Ask to build one.</p>
          )}
        </section>
      );
    default:
      return null; // an unknown part is never rendered
  }
}

function DashboardWidget() {
  const { data, error } = useWidget<Dashboard>("Dashboard");
  if (error) return <p className="widget error">{error}</p>;
  if (!data) return <p className="widget muted">Building the dashboard…</p>;
  return (
    <div className="widget">
      <h1>{data.title}</h1>
      {data.blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DashboardWidget />
  </StrictMode>,
);
