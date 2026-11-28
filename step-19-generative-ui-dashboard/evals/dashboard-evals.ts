export const DASHBOARD_TOOL_WIDGETS = {
  show_dashboard: "dashboard",
  list_orders: "orders-table",
  get_sales_summary: "sales-chart",
  open_order_form: "order-form",
  start_sales_report: "task-status",
} as const;

export const TEXT_TOOLS = new Set(["get_order", "answer_business_question", "search_sales_policy"]);

export const BLOCK_TYPES = new Set(["kpi", "chart", "table", "report"]);

export interface DashboardIntent {
  id: number;
  prompt: string;
  tool: string;
  widget: string;
  blocks: string[];
  note?: string;
}

export interface DashboardIntentSet {
  about: string;
  prompts: DashboardIntent[];
}

export function dashboardIntentErrors(value: unknown): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== "object") return ["the eval file must contain an object"];

  const set = value as { about?: unknown; prompts?: unknown };
  if (typeof set.about !== "string" || set.about.trim().length < 10) errors.push("about must be a sentence");
  if (!Array.isArray(set.prompts)) return [...errors, "prompts must be an array"];

  const rows: unknown[] = set.prompts;
  if (rows.length !== 20) errors.push(`expected 20 prompts, got ${rows.length}`);
  const ids = new Set<number>();
  const prompts = new Set<string>();

  for (const [index, raw] of rows.entries()) {
    const label = `prompt ${index + 1}`;
    if (!raw || typeof raw !== "object") {
      errors.push(`${label}: must be an object`);
      continue;
    }
    const p = raw as Partial<DashboardIntent>;

    if (typeof p.id !== "number" || !Number.isInteger(p.id)) {
      errors.push(`${label}: id must be an integer`);
    } else {
      if (ids.has(p.id)) errors.push(`${label}: duplicate id ${p.id}`);
      ids.add(p.id);
      if (p.id !== index + 1) errors.push(`${label}: id should be ${index + 1}`);
    }

    if (typeof p.prompt !== "string" || p.prompt.trim().length < 8) {
      errors.push(`${label}: prompt is too short`);
    } else {
      if (prompts.has(p.prompt)) errors.push(`${label}: duplicate prompt`);
      prompts.add(p.prompt);
    }

    if (typeof p.tool !== "string" || p.tool.trim().length === 0) errors.push(`${label}: tool must be a string`);
    if (typeof p.widget !== "string" || p.widget.trim().length === 0) errors.push(`${label}: widget must be a string`);

    if (!Array.isArray(p.blocks)) {
      errors.push(`${label}: blocks must be an array`);
      continue;
    }
    for (const block of p.blocks) {
      if (typeof block !== "string" || !BLOCK_TYPES.has(block)) errors.push(`${label}: unknown block ${String(block)}`);
    }

    const tool = typeof p.tool === "string" && p.tool.trim().length > 0 ? p.tool : "";
    const widget = typeof p.widget === "string" && p.widget.trim().length > 0 ? p.widget : "";
    if (tool === "show_dashboard") {
      if (widget !== "dashboard") errors.push(`${label}: show_dashboard must expect the dashboard widget`);
      if (p.blocks.length === 0) errors.push(`${label}: show_dashboard needs at least one block`);
    } else {
      const expected: string | undefined = (DASHBOARD_TOOL_WIDGETS as Record<string, string | undefined>)[tool];
      const wants = expected ?? "none";
      if (widget !== wants) errors.push(`${label}: expected widget "${wants}" for ${tool}, got "${widget}"`);
      if (p.blocks.length > 0) errors.push(`${label}: only show_dashboard may expect blocks`);
      if (wants === "none" && !TEXT_TOOLS.has(tool)) errors.push(`${label}: unknown tool ${tool}`);
    }

    if (p.note !== undefined && typeof p.note !== "string") errors.push(`${label}: note must be a string`);
  }

  return errors;
}
