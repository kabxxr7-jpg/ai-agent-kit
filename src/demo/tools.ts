import { defineTool, ToolRegistry, type Tool } from "../tools";
import type { SupportStore } from "./store";

export const REFUND_WINDOW_DAYS = 30;

const orderId = { type: "string", pattern: "^ORD-[0-9]{4}$", description: "Order id such as ORD-1001" };

export type RefundReason = "eligible" | "window_expired" | "not_delivered" | "already_refunded" | "order_not_found";

export function lookupOrderTool(store: SupportStore): Tool {
  return defineTool({
    name: "lookup_order",
    description: "Look up an order by id. Returns its items, total, status and dates.",
    inputSchema: { type: "object", properties: { orderId }, required: ["orderId"], additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: {
        found: { type: "boolean" },
        order: {
          type: "object",
          properties: {
            id: { type: "string" },
            customer: { type: "string" },
            status: { type: "string", enum: ["processing", "shipped", "delivered", "refunded", "cancelled"] },
            total: { type: "number" },
            orderedAt: { type: "string" },
            deliveredAt: { type: "string" },
            items: { type: "array", items: { type: "object" } },
            note: { type: "string" },
          },
          required: ["id", "customer", "status", "total", "orderedAt", "items"],
        },
      },
      required: ["found"],
      additionalProperties: false,
    },
    execute({ orderId }: { orderId: string }) {
      const order = store.getOrder(orderId);
      return order ? { found: true, order } : { found: false };
    },
  });
}

export function refundEligibilityTool(store: SupportStore): Tool {
  return defineTool({
    name: "check_refund_eligibility",
    description: `Check whether an order can be refunded. Policy: delivered orders, within ${REFUND_WINDOW_DAYS} days of delivery, not already refunded.`,
    inputSchema: { type: "object", properties: { orderId }, required: ["orderId"], additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: {
        eligible: { type: "boolean" },
        reason: { type: "string", enum: ["eligible", "window_expired", "not_delivered", "already_refunded", "order_not_found"] },
        maxRefund: { type: "number", minimum: 0 },
      },
      required: ["eligible", "reason", "maxRefund"],
      additionalProperties: false,
    },
    execute({ orderId }: { orderId: string }) {
      const order = store.getOrder(orderId);
      const result = (reason: RefundReason, maxRefund = 0) => ({ eligible: reason === "eligible", reason, maxRefund });
      if (!order) return result("order_not_found");
      if (order.status === "refunded") return result("already_refunded");
      if (order.status !== "delivered" || !order.deliveredAt) return result("not_delivered");
      if (store.daysSince(order.deliveredAt) > REFUND_WINDOW_DAYS) return result("window_expired");
      return result("eligible", order.total);
    },
  });
}

export function createTicketTool(store: SupportStore): Tool {
  return defineTool({
    name: "create_support_ticket",
    description: "Open a support ticket for a human agent. Use when the request cannot be settled with the other tools.",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", minLength: 3, maxLength: 120 },
        body: { type: "string", minLength: 3, maxLength: 1000 },
        priority: { type: "string", enum: ["low", "normal", "high"] },
        orderId: { ...orderId },
      },
      required: ["subject", "body", "priority"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { ticketId: { type: "string", pattern: "^TCK-[0-9]{4}$" }, status: { type: "string", const: "open" } },
      required: ["ticketId", "status"],
      additionalProperties: false,
    },
    execute(input: { subject: string; body: string; priority: "low" | "normal" | "high"; orderId?: string }) {
      if (input.orderId && !store.getOrder(input.orderId)) throw new Error(`order ${input.orderId} does not exist`);
      const ticket = store.createTicket(input);
      return { ticketId: ticket.id, status: ticket.status };
    },
  });
}

/** Destructive on purpose. Registered so that tests can prove the allow-list keeps it out of reach. */
export function deleteAllTool(store: SupportStore): Tool {
  return defineTool({
    name: "delete_all",
    description: "Delete every order and ticket. Not part of the support agent.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object", properties: { deleted: { type: "integer", minimum: 0 } }, required: ["deleted"] },
    execute() {
      return { deleted: store.deleteAll() };
    },
  });
}

export const SUPPORT_TOOL_NAMES = ["lookup_order", "check_refund_eligibility", "create_support_ticket"];

export function createSupportRegistry(store: SupportStore, options: { withDeleteAll?: boolean } = {}): ToolRegistry {
  const registry = new ToolRegistry([lookupOrderTool(store), refundEligibilityTool(store), createTicketTool(store)]);
  if (options.withDeleteAll ?? true) registry.register(deleteAllTool(store));
  return registry;
}
