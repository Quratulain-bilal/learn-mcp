import type {
  BusinessQuestion,
  CreateOrderInput,
  ListOrdersInput,
  SalesStore,
  SummaryGroupBy,
} from "./sales";

interface MemoryLine {
  orgId: string;
  orderId: string;
  orderDate: string;
  customerId: string;
  customerName: string;
  customerCity: string;
  productId: string;
  productName: string;
  unitPrice: number;
  quantity: number;
}

const CUSTOMERS = [
  { id: "cust-ayesha", name: "Ayesha Khan", city: "Karachi" },
  { id: "cust-bilal", name: "Bilal Ahmed", city: "Lahore" },
  { id: "cust-sara", name: "Sara Ali", city: "Islamabad" },
] as const;

const PRODUCTS = [
  { id: "prod-laptop", name: "Laptop", price: 1200 },
  { id: "prod-mouse", name: "Mouse", price: 25 },
  { id: "prod-monitor", name: "Monitor", price: 300 },
] as const;

const BASE_LINES = [
  ["ORD-2001", "2026-01-05", 0, 0, 0, 1],
  ["ORD-2002", "2026-02-11", 1, 1, 1, 2],
  ["ORD-2003", "2026-03-18", 2, 2, 2, 1],
  ["ORD-2004", "2026-04-22", 0, 2, 0, 3],
] as const;

function money(value: number): string {
  return value.toFixed(2);
}

export function createMemorySalesStore(): SalesStore {
  const linesByOrg = new Map<string, MemoryLine[]>();

  function linesFor(orgId: string): MemoryLine[] {
    const existing = linesByOrg.get(orgId);
    if (existing) return existing;
    const rows = BASE_LINES.map(([orderId, orderDate, customerIndex, productIndex, quantityIndex, quantity]) => {
      const customer = CUSTOMERS[customerIndex];
      const product = PRODUCTS[productIndex];
      return {
        orgId,
        orderId,
        orderDate,
        customerId: customer.id,
        customerName: customer.name,
        customerCity: customer.city,
        productId: product.id,
        productName: product.name,
        unitPrice: product.price,
        quantity,
      };
    });
    linesByOrg.set(orgId, rows);
    return rows;
  }

  function ordersFor(orgId: string) {
    const grouped = new Map<string, {
      orderId: string;
      orderDate: string;
      customerId: string;
      customerName: string;
      itemCount: number;
      total: number;
      productIds: string[];
    }>();
    for (const line of linesFor(orgId)) {
      const order = grouped.get(line.orderId) ?? {
        orderId: line.orderId,
        orderDate: line.orderDate,
        customerId: line.customerId,
        customerName: line.customerName,
        itemCount: 0,
        total: 0,
        productIds: [],
      };
      order.itemCount += 1;
      order.total += line.unitPrice * line.quantity;
      order.productIds.push(line.productId);
      grouped.set(line.orderId, order);
    }
    return [...grouped.values()].sort(
      (left, right) => right.orderDate.localeCompare(left.orderDate) || right.orderId.localeCompare(left.orderId),
    );
  }

  return {
    async describeSchema() {
      return {
        tables: [
          {
            schema: "public",
            name: "customers",
            columns: [{ name: "org_id", type: "text", nullable: false }],
            keys: [{ type: "PRIMARY KEY", columns: ["org_id", "customer_id"] }],
          },
          {
            schema: "public",
            name: "orders",
            columns: [{ name: "org_id", type: "text", nullable: false }],
            keys: [{ type: "PRIMARY KEY", columns: ["org_id", "order_id"] }],
          },
          {
            schema: "staging",
            name: "flat_sales",
            columns: [{ name: "org_id", type: "text", nullable: false }],
            keys: [],
          },
        ],
      };
    },

    async answer(orgId, question) {
      const rows = linesFor(orgId);
      if (question === "units_sold") {
        return { question, rows: [{ units: rows.reduce((sum, line) => sum + line.quantity, 0) }] };
      }
      if (question === "monthly_revenue") {
        const totals = new Map<string, number>();
        for (const line of rows) {
          const month = line.orderDate.slice(0, 7);
          totals.set(month, (totals.get(month) ?? 0) + line.unitPrice * line.quantity);
        }
        return {
          question,
          rows: [...totals.entries()].map(([month, revenue]) => ({ month, revenue: money(revenue) })),
        };
      }
      return { question, rows: [{ org_id: orgId, question, total: "100.00" }] };
    },

    async compare(orgId, question) {
      return {
        question,
        flat: [{ org_id: orgId, source: "flat" }],
        normalized: [{ org_id: orgId, source: "normalized" }],
        anomalies: ["The flat design repeats customer and product facts."],
      };
    },

    async listOrders(orgId, input: ListOrdersInput) {
      const limit = input.limit ?? 20;
      const offset = Number(input.cursor ?? "0");
      const filtered = ordersFor(orgId).filter((order) => {
        if (input.from && order.orderDate < input.from) return false;
        if (input.to && order.orderDate > input.to) return false;
        if (input.customerId && order.customerId !== input.customerId) return false;
        if (input.productId && !order.productIds.includes(input.productId)) return false;
        return true;
      });
      const page = filtered.slice(offset, offset + limit).map((order) => ({
        org_id: orgId,
        order_id: order.orderId,
        order_date: order.orderDate,
        customer: order.customerName,
        item_count: order.itemCount,
        total: money(order.total),
      }));
      return {
        orders: page,
        nextCursor: offset + limit < filtered.length ? String(offset + limit) : null,
      };
    },

    async getSalesSummary(orgId, groupBy: SummaryGroupBy) {
      const rows = linesFor(orgId);
      const totals = new Map<string, { units: number; total: number }>();
      for (const line of rows) {
        const label = groupBy === "month"
          ? line.orderDate.slice(0, 7)
          : groupBy === "product"
            ? line.productName
            : line.customerName;
        const current = totals.get(label) ?? { units: 0, total: 0 };
        current.units += groupBy === "product" ? line.quantity : 1;
        current.total += line.unitPrice * line.quantity;
        totals.set(label, current);
      }
      return {
        groupBy,
        rows: [...totals.entries()].map(([label, value]) => ({
          org_id: orgId,
          label,
          units: value.units,
          total: money(value.total),
        })),
      };
    },

    async createOrder(orgId, input: CreateOrderInput) {
      const rows = linesFor(orgId);
      if (rows.some((line) => line.orderId === input.orderId)) {
        throw new Error("Order already exists in your company.");
      }
      if (!CUSTOMERS.some((customer) => customer.id === input.customerId)) {
        throw new Error("Customer not found in your company.");
      }
      for (const item of input.items) {
        if (!PRODUCTS.some((product) => product.id === item.productId)) {
          throw new Error("Product not found in your company.");
        }
      }
      const customer = CUSTOMERS.find((entry) => entry.id === input.customerId);
      let total = 0;
      input.items.forEach((item) => {
        const product = PRODUCTS.find((entry) => entry.id === item.productId);
        if (!customer || !product) return;
        total += product.price * item.quantity;
        rows.push({
          orgId,
          orderId: input.orderId,
          orderDate: input.orderDate,
          customerId: customer.id,
          customerName: customer.name,
          customerCity: customer.city,
          productId: product.id,
          productName: product.name,
          unitPrice: product.price,
          quantity: item.quantity,
        });
      });
      return { orderId: input.orderId, itemCount: input.items.length, total: money(total) };
    },
  };
}
