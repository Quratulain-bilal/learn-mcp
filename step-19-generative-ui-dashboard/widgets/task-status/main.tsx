import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../shared/widget.css";
import { callTool, formatMoney, useWidget } from "../shared/useWidget";

/**
 * REPORT PROGRESS, shown with start_sales_report: the fallback for apps without MCP Tasks.
 * It polls get_report_status every few seconds (through the host, so every poll is
 * checked against the caller's company) until the report is ready, failed or cancelled,
 * then shows the report.
 */

interface Started {
  report_id: string;
  year: number;
}
interface Status {
  report_id: string;
  stage: string;
  run_status: string;
  error: string | null;
  report: {
    year: number;
    orders: number;
    revenue: number;
    months: { month: string; revenue: number }[];
    topProducts: { product: string; revenue: number }[];
    topCustomers: { customer: string; revenue: number }[];
  } | null;
}

const STAGES = ["queued", "reading", "computing", "awaiting_approval", "published"];
const LABELS: Record<string, string> = {
  queued: "Queued",
  reading: "Reading orders",
  computing: "Computing totals",
  awaiting_approval: "Ready: waiting for approval",
  published: "Published",
  expired: "Approval timed out",
  failed: "Failed",
  cancelled: "Cancelled",
};
const DONE = new Set(["awaiting_approval", "published", "expired", "failed", "cancelled"]);
const POLL_MS = 3000;

function TaskStatus() {
  const { app, data: started, error } = useWidget<Started>("TaskStatus");
  const [status, setStatus] = useState<Status | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

  useEffect(() => {
    if (!app || !started) return;
    let stopped = false;
    const poll = async () => {
      try {
        const s = await callTool<Status>(app, "get_report_status", { report_id: started.report_id });
        if (stopped) return;
        setStatus(s);
        setPollError(null);
        if (!DONE.has(s.stage)) setTimeout(poll, POLL_MS);
      } catch (e) {
        if (stopped) return;
        setPollError((e as Error).message);
        setTimeout(poll, POLL_MS * 2);
      }
    };
    void poll();
    return () => {
      stopped = true;
    };
  }, [app, started]);

  if (error) return <p className="widget error">{error}</p>;
  if (!started) return <p className="widget muted">Starting the report…</p>;

  const stage = status?.stage ?? "queued";
  const step = Math.max(0, STAGES.indexOf(stage));
  const report = status?.report;

  return (
    <div className="widget">
      <h1>{started.year} sales report</h1>
      <p className="sub" aria-live="polite">
        {LABELS[stage] ?? stage}
        {!DONE.has(stage) ? "…" : ""}
      </p>
      <div role="progressbar" aria-valuemin={0} aria-valuemax={STAGES.length - 1} aria-valuenow={step}
        style={{ height: 6, background: "var(--w-bg-2)", borderRadius: 3, overflow: "hidden", marginBottom: 12 }}>
        <div style={{ width: `${(step / (STAGES.length - 1)) * 100}%`, height: "100%", background: "var(--w-accent)", transition: "width .4s" }} />
      </div>
      {status?.error && <p className="error">{status.error}</p>}
      {pollError && <p className="error">{pollError}</p>}
      {report && (
        <>
          <p>
            <strong>{formatMoney(report.revenue)}</strong> from {report.orders} orders.
          </p>
          <table>
            <thead>
              <tr>
                <th scope="col">Top product</th>
                <th scope="col" className="num">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {report.topProducts.map((p) => (
                <tr key={p.product}>
                  <td>{p.product}</td>
                  <td className="num">{formatMoney(p.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {stage === "awaiting_approval" && (
            <div className="footer">
              <span className="muted">An admin can publish it.</span>
              <button
                onClick={() =>
                  void app?.sendMessage({
                    role: "user",
                    content: [{ type: "text", text: `Approve the sales report ${started.report_id}.` }],
                  })
                }
              >
                Ask to approve
              </button>
            </div>
          )}
        </>
      )}
      <p className="sub" style={{ marginTop: 10 }}>Report id: {started.report_id}</p>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TaskStatus />
  </StrictMode>,
);
