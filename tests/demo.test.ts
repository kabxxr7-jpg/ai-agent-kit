import { describe, expect, it } from "vitest";
import { SupportStore } from "../src/demo/store";
import { runSupportAgent, SUPPORT_ANSWER_SCHEMA } from "../src/demo/support-agent";
import { createSupportRegistry } from "../src/demo/tools";
import { createMockModel } from "../src/models/mock";
import { validate } from "../src/schema";
import { call, calls, say } from "./helpers";

const run = async (store: SupportStore, name: string, args: unknown) => createSupportRegistry(store).execute(name, args);

describe("lookup_order", () => {
  it("finds an order and reports a missing one without failing", async () => {
    const store = new SupportStore();
    const found = await run(store, "lookup_order", { orderId: "ORD-1001" });
    expect(found).toMatchObject({ ok: true, output: { found: true, order: { id: "ORD-1001", status: "delivered", total: 49.9 } } });
    expect(await run(store, "lookup_order", { orderId: "ORD-9999" })).toEqual({ ok: true, output: { found: false } });
  });

  it("rejects a malformed order id at the schema", async () => {
    const r = await run(new SupportStore(), "lookup_order", { orderId: "1001" });
    expect(r).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
  });

  it("seed order totals match their items", () => {
    for (const o of new SupportStore().orders.values()) {
      const sum = o.items.reduce((acc, i) => acc + i.qty * i.unitPrice, 0);
      expect(Math.round(sum * 100) / 100).toBe(o.total);
    }
  });
});

describe("check_refund_eligibility", () => {
  const check = async (id: string, store = new SupportStore()) => (await run(store, "check_refund_eligibility", { orderId: id })) as { ok: true; output: Record<string, unknown> };

  it("approves a delivered order inside the window, up to its total", async () => {
    expect((await check("ORD-1001")).output).toEqual({ eligible: true, reason: "eligible", maxRefund: 49.9 });
  });

  it("denies when the window has passed", async () => {
    expect((await check("ORD-1002")).output).toEqual({ eligible: false, reason: "window_expired", maxRefund: 0 });
  });

  it("denies an order that has not been delivered", async () => {
    expect((await check("ORD-1003")).output).toMatchObject({ eligible: false, reason: "not_delivered" });
  });

  it("denies an already refunded order and an unknown one", async () => {
    expect((await check("ORD-1005")).output).toMatchObject({ reason: "already_refunded" });
    expect((await check("ORD-4040")).output).toMatchObject({ reason: "order_not_found" });
  });

  it("uses the store's date: the same order is eligible on day 30 and not on day 31", async () => {
    // ORD-1001 was delivered 2026-06-05
    expect((await check("ORD-1001", new SupportStore("2026-07-05"))).output).toMatchObject({ eligible: true });
    expect((await check("ORD-1001", new SupportStore("2026-07-06"))).output).toMatchObject({ eligible: false, reason: "window_expired" });
  });
});

describe("create_support_ticket", () => {
  const input = { subject: "Cracked mug", body: "Handle cracked on arrival.", priority: "normal", orderId: "ORD-1001" };

  it("creates tickets with sequential ids", async () => {
    const store = new SupportStore();
    expect(await run(store, "create_support_ticket", input)).toEqual({ ok: true, output: { ticketId: "TCK-0001", status: "open" } });
    expect(await run(store, "create_support_ticket", { ...input, orderId: undefined })).toMatchObject({ output: { ticketId: "TCK-0002" } });
    expect(store.tickets).toHaveLength(2);
    expect(store.tickets[0]).toMatchObject({ orderId: "ORD-1001", priority: "normal" });
  });

  it("returns a tool error for an unknown order and creates nothing", async () => {
    const store = new SupportStore();
    const r = await run(store, "create_support_ticket", { ...input, orderId: "ORD-9999" });
    expect(r).toMatchObject({ ok: false, error: { code: "tool_error", message: "order ORD-9999 does not exist" } });
    expect(store.tickets).toHaveLength(0);
  });

  it("validates priority, lengths and extra fields", async () => {
    const store = new SupportStore();
    for (const bad of [{ ...input, priority: "urgent" }, { ...input, subject: "" }, { ...input, body: "x".repeat(1001) }, { ...input, extra: 1 }, { subject: "abc", body: "abc" }]) {
      expect((await run(store, "create_support_ticket", bad)).ok).toBe(false);
    }
    expect(store.tickets).toHaveLength(0);
  });
});

describe("support agent end to end (scripted model)", () => {
  it("refund question: lookup, policy check, schema-valid answer", async () => {
    const store = new SupportStore();
    const model = createMockModel([
      calls(call("lookup_order", { orderId: "ORD-1001" })),
      calls(call("check_refund_eligibility", { orderId: "ORD-1001" })),
      say({ resolution: "refund_eligible", orderId: "ORD-1001", summary: "Inside the 30-day window; up to 49.90." }),
    ]);
    const r = await runSupportAgent({ model, input: "Refund for ORD-1001?", store });
    expect(r.stopReason).toBe("done");
    expect(r.toolCalls.map((c) => c.name)).toEqual(["lookup_order", "check_refund_eligibility"]);
    expect(validate(SUPPORT_ANSWER_SCHEMA, r.finalAnswer)).toEqual([]);
    expect(r.finalAnswer).toMatchObject({ resolution: "refund_eligible" });
    // the model was shown exactly the three support tools
    expect(model.calls[0]!.tools.map((t) => t.name)).toEqual(["lookup_order", "check_refund_eligibility", "create_support_ticket"]);
  });

  it("escalation: opens a ticket and cites its id", async () => {
    const store = new SupportStore();
    const model = createMockModel([
      calls(call("create_support_ticket", { subject: "Refund dispute", body: "Customer disputes the window.", priority: "high", orderId: "ORD-1002" })),
      say({ resolution: "ticket_created", ticketId: "TCK-0001", orderId: "ORD-1002", summary: "Escalated to a human." }),
    ]);
    const r = await runSupportAgent({ model, input: "I demand a refund on ORD-1002", store });
    expect(r.stopReason).toBe("done");
    expect(store.tickets).toHaveLength(1);
    expect(r.finalAnswer).toMatchObject({ ticketId: "TCK-0001" });
  });

  it("an answer outside the schema (invented resolution) is not accepted", async () => {
    const model = createMockModel([say({ resolution: "refund_issued", summary: "done" }), say({ resolution: "refund_issued", summary: "done" })]);
    const r = await runSupportAgent({ model, input: "hi", store: new SupportStore() });
    expect(r.error?.code).toBe("invalid_final_answer");
  });
});
