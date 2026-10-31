import { describe, expect, it } from "vitest";
import { runAgent } from "../src/agent";
import { createMockModel } from "../src/models/mock";
import type { JsonSchema } from "../src/types";
import { call, calls, makeRegistry, say } from "./helpers";

const lastToolMessage = (messages: { role: string; content: string }[]) => messages.filter((m) => m.role === "tool").at(-1)!.content;

describe("tool allow-list", () => {
  it("refuses a registered tool that is not allowed, never runs it, and tells the model", async () => {
    const { registry, executed } = makeRegistry();
    const model = createMockModel([calls(call("danger")), say("ok, without it")]);
    const r = await runAgent({ model, tools: registry, allowedTools: ["echo"], input: "go" });

    expect(r.stopReason).toBe("done");
    expect(executed).toEqual([]);
    expect(r.toolCalls).toMatchObject([{ name: "danger", status: "tool_not_allowed", executed: false }]);
    expect(lastToolMessage(model.calls[1]!.messages)).toContain("tool_not_allowed");
  });

  it("never lists a disallowed tool to the model", async () => {
    const { registry } = makeRegistry();
    const model = createMockModel([say("ok")]);
    await runAgent({ model, tools: registry, allowedTools: ["echo", "boom"], input: "go" });
    expect(model.calls[0]!.tools.map((t) => t.name).sort()).toEqual(["boom", "echo"]);
  });

  it("aborts when a second disallowed call follows the first", async () => {
    const { registry, executed } = makeRegistry();
    const model = createMockModel([calls(call("danger", {}, "a")), calls(call("danger", {}, "b")), say("never")]);
    const r = await runAgent({ model, tools: registry, allowedTools: ["echo"], input: "go" });
    expect(r).toMatchObject({ stopReason: "error", error: { code: "tool_not_allowed" } });
    expect(executed).toEqual([]);
    expect(model.calls).toHaveLength(2);
  });

  it("treats an unregistered tool name as unknown_tool", async () => {
    const { registry } = makeRegistry();
    const model = createMockModel([calls(call("rm_rf")), say("fine")]);
    const r = await runAgent({ model, tools: registry, allowedTools: ["echo"], input: "go" });
    expect(r.toolCalls[0]).toMatchObject({ name: "rm_rf", status: "unknown_tool", executed: false });
    expect(r.stopReason).toBe("done");
  });

  it("an explicit empty allow-list offers no tools and refuses every call", async () => {
    const { registry, executed } = makeRegistry();
    const model = createMockModel([calls(call("echo", { message: "x" })), say("ok")]);
    const r = await runAgent({ model, tools: registry, allowedTools: [], input: "go" });
    expect(model.calls[0]!.tools).toEqual([]);
    expect(executed).toEqual([]);
    expect(r.toolCalls[0]!.status).toBe("tool_not_allowed");
  });

  it("refuses only the bad call in a batch of calls, and still runs the allowed one", async () => {
    const { registry, executed } = makeRegistry();
    const model = createMockModel([calls(call("danger", {}, "a"), call("echo", { message: "hi" }, "b")), say("done")]);
    const r = await runAgent({ model, tools: registry, allowedTools: ["echo"], input: "go" });
    expect(executed.map((e) => e.name)).toEqual(["echo"]);
    expect(r.toolCalls.map((c) => c.status)).toEqual(["tool_not_allowed", "ok"]);
    // every call in the assistant message got a tool message back
    expect(r.newMessages.filter((m) => m.role === "tool").map((m) => m.toolCallId)).toEqual(["a", "b"]);
  });
});

describe("argument validation", () => {
  it("feeds the first validation error back and lets the model fix the call", async () => {
    const { registry, executed } = makeRegistry();
    const model = createMockModel([calls(call("echo", { message: 42 })), calls(call("echo", { message: "fixed" })), say("ok")]);
    const r = await runAgent({ model, tools: registry, allowedTools: ["echo"], input: "go" });

    expect(r.stopReason).toBe("done");
    expect(executed).toEqual([{ name: "echo", input: { message: "fixed" } }]);
    const feedback = lastToolMessage(model.calls[1]!.messages);
    expect(feedback).toContain("invalid_arguments");
    expect(feedback).toContain("$.message: expected string, got number");
    expect(r.toolCalls.map((c) => c.status)).toEqual(["invalid_arguments", "ok"]);
  });

  it("aborts on the second invalid call in a row", async () => {
    const { registry, executed } = makeRegistry();
    const model = createMockModel([calls(call("echo", {})), calls(call("echo", { message: 1 })), say("never")]);
    const r = await runAgent({ model, tools: registry, allowedTools: ["echo"], input: "go" });
    expect(r).toMatchObject({ stopReason: "error", error: { code: "invalid_arguments" }, steps: 2 });
    expect(executed).toEqual([]);
    expect(model.calls).toHaveLength(2);
  });

  it("does not echo the offending value back to the model", async () => {
    const { registry } = makeRegistry();
    const secret = "tok_do_not_repeat_me";
    const model = createMockModel([calls(call("echo", { message: 1, extra: secret })), say("ok")]);
    await runAgent({ model, tools: registry, allowedTools: ["echo"], input: "go" });
    expect(lastToolMessage(model.calls[1]!.messages)).not.toContain(secret);
  });

  it("resets the strike count after a successful call", async () => {
    const { registry } = makeRegistry();
    const model = createMockModel([
      calls(call("echo", {})), // strike 1, fed back
      calls(call("echo", { message: "ok" })), // success resets
      calls(call("echo", {}, "x")), // strike 1 again, still fine
      say("done"),
    ]);
    const r = await runAgent({ model, tools: registry, allowedTools: ["echo"], input: "go" });
    expect(r.stopReason).toBe("done");
  });

  it("counts an invalid call as a strike across mixed kinds (bad args then disallowed tool)", async () => {
    const { registry } = makeRegistry();
    const model = createMockModel([calls(call("echo", {})), calls(call("danger")), say("never")]);
    const r = await runAgent({ model, tools: registry, allowedTools: ["echo"], input: "go" });
    expect(r).toMatchObject({ stopReason: "error", error: { code: "tool_not_allowed" } });
  });
});

describe("tool failures", () => {
  it("catches a throwing tool and returns a structured error to the model", async () => {
    const { registry } = makeRegistry();
    const model = createMockModel([calls(call("boom")), say("sorry, that failed")]);
    const r = await runAgent({ model, tools: registry, allowedTools: ["boom"], input: "go" });

    expect(r).toMatchObject({ stopReason: "done", finalAnswer: "sorry, that failed" });
    expect(r.toolCalls[0]).toMatchObject({ status: "tool_error", executed: true });
    const msg = lastToolMessage(model.calls[1]!.messages);
    expect(msg).toContain('status="error"');
    expect(msg).toContain('"code":"tool_error"');
    expect(msg).toContain("kaboom: disk on fire");
  });

  it("does not treat a tool error as a strike (the model may retry differently)", async () => {
    const { registry } = makeRegistry();
    const model = createMockModel([calls(call("boom", {}, "1")), calls(call("echo", { message: "a" })), calls(call("boom", {}, "3")), say("done")]);
    const r = await runAgent({ model, tools: registry, allowedTools: ["boom", "echo"], input: "go", limits: { maxIdenticalCalls: 3 } });
    expect(r.stopReason).toBe("done");
  });

  it("reports output that breaks the output schema as invalid_output", async () => {
    const { registry } = makeRegistry();
    const model = createMockModel([calls(call("bad_output")), say("ok")]);
    const r = await runAgent({ model, tools: registry, allowedTools: ["bad_output"], input: "go" });
    expect(r.toolCalls[0]).toMatchObject({ status: "invalid_output", executed: true });
    expect(lastToolMessage(model.calls[1]!.messages)).toContain("invalid_output");
    // the bad data itself is not passed on
    expect(lastToolMessage(model.calls[1]!.messages)).not.toContain("not a number");
  });
});

describe("loop breaker", () => {
  it("stops on the third identical call and does not run it", async () => {
    const { registry, executed } = makeRegistry();
    const same = () => calls(call("echo", { message: "again" }));
    const model = createMockModel([same(), same(), same(), same(), say("never")]);
    const r = await runAgent({ model, tools: registry, allowedTools: ["echo"], input: "go" });
    expect(r).toMatchObject({ stopReason: "error", error: { code: "repeated_call" }, steps: 3 });
    expect(executed).toHaveLength(2);
    expect(r.toolCalls.map((c) => c.status)).toEqual(["ok", "ok", "repeated_call"]);
  });

  it("sees through key order, also in nested objects", async () => {
    const { registry, executed } = makeRegistry();
    const r = await runAgent({
      model: createMockModel([
        calls(call("free", { a: 1, b: { x: 1, y: 2 } })),
        calls(call("free", { b: { y: 2, x: 1 }, a: 1 })),
        calls(call("free", { a: 1, b: { x: 1, y: 2 } })),
        say("never"),
      ]),
      tools: registry,
      allowedTools: ["free"],
      input: "go",
    });
    expect(r.error?.code).toBe("repeated_call");
    expect(executed).toHaveLength(2);
  });

  it("does not trigger for different arguments", async () => {
    const { registry } = makeRegistry();
    const script = [1, 2, 3, 4, 5].map((i) => calls(call("echo", { message: `m${i}` })));
    const r = await runAgent({ model: createMockModel([...script, say("fine")]), tools: registry, allowedTools: ["echo"], input: "go", limits: { maxSteps: 10 } });
    expect(r.stopReason).toBe("done");
  });

  it("honours maxIdenticalCalls", async () => {
    const { registry, executed } = makeRegistry();
    const same = () => calls(call("echo", { message: "x" }));
    const r = await runAgent({ model: createMockModel([same(), same(), same(), same()]), tools: registry, allowedTools: ["echo"], input: "go", limits: { maxIdenticalCalls: 1 } });
    expect(r.error?.code).toBe("repeated_call");
    expect(executed).toHaveLength(1);
  });

  it("detects repeats inside a single turn", async () => {
    const { registry, executed } = makeRegistry();
    const turn = calls(call("echo", { message: "x" }, "a"), call("echo", { message: "x" }, "b"), call("echo", { message: "x" }, "c"));
    const r = await runAgent({ model: createMockModel([turn]), tools: registry, allowedTools: ["echo"], input: "go" });
    expect(r.error?.code).toBe("repeated_call");
    expect(executed).toHaveLength(2);
  });
});

describe("final answer schema", () => {
  const schema: JsonSchema = {
    type: "object",
    properties: { status: { type: "string", enum: ["ok", "failed"] }, detail: { type: "string" } },
    required: ["status"],
    additionalProperties: false,
  };

  it("parses and returns a valid JSON answer", async () => {
    const { registry } = makeRegistry();
    const r = await runAgent({ model: createMockModel([say({ status: "ok", detail: "x" })]), tools: registry, allowedTools: [], input: "go", finalAnswerSchema: schema });
    expect(r).toMatchObject({ stopReason: "done", finalAnswer: { status: "ok", detail: "x" } });
  });

  it("accepts JSON inside a code fence", async () => {
    const { registry } = makeRegistry();
    const r = await runAgent({ model: createMockModel([say('```json\n{"status":"ok"}\n```')]), tools: registry, allowedTools: [], input: "go", finalAnswerSchema: schema });
    expect(r.finalAnswer).toEqual({ status: "ok" });
  });

  it("tells the model the schema in the system prompt", async () => {
    const { registry } = makeRegistry();
    const model = createMockModel([say({ status: "ok" })]);
    await runAgent({ model, tools: registry, allowedTools: [], input: "go", finalAnswerSchema: schema });
    expect(model.calls[0]!.messages[0]!.content).toContain('"enum":["ok","failed"]');
  });

  it("feeds a rejected answer back once and accepts the correction", async () => {
    const { registry } = makeRegistry();
    const model = createMockModel([say({ status: "maybe" }), say({ status: "failed" })]);
    const r = await runAgent({ model, tools: registry, allowedTools: [], input: "go", finalAnswerSchema: schema });
    expect(r).toMatchObject({ stopReason: "done", finalAnswer: { status: "failed" }, steps: 2 });
    const feedback = model.calls[1]!.messages.at(-1)!;
    expect(feedback.role).toBe("user");
    expect(feedback.content).toContain("$.status: must be one of");
  });

  it("aborts when the second answer is also invalid", async () => {
    const { registry } = makeRegistry();
    const model = createMockModel([say("not json at all"), say({ status: "nope" }), say({ status: "ok" })]);
    const r = await runAgent({ model, tools: registry, allowedTools: [], input: "go", finalAnswerSchema: schema });
    expect(r).toMatchObject({ stopReason: "error", error: { code: "invalid_final_answer" } });
    expect(r.finalAnswer).toBeUndefined();
    expect(model.calls).toHaveLength(2);
  });

  it("rejects extra fields and wrong types", async () => {
    const { registry } = makeRegistry();
    const r = await runAgent({ model: createMockModel([say({ status: "ok", surprise: 1 }), say({ status: 3 })]), tools: registry, allowedTools: [], input: "go", finalAnswerSchema: schema });
    expect(r.error?.code).toBe("invalid_final_answer");
    expect(r.error?.message).toContain("$.status: expected string, got number");
  });

  it("without a schema any text is accepted as is", async () => {
    const { registry } = makeRegistry();
    const r = await runAgent({ model: createMockModel([say("{not json")]), tools: registry, allowedTools: [], input: "go" });
    expect(r).toMatchObject({ stopReason: "done", finalAnswer: "{not json" });
  });
});
