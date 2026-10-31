import { describe, expect, it } from "vitest";
import { runAgent } from "../src/agent";
import { createMockModel } from "../src/models/mock";
import { call, calls, makeRegistry, say } from "./helpers";

describe("runAgent basics", () => {
  it("returns the text when the model answers straight away", async () => {
    const { registry } = makeRegistry();
    const model = createMockModel([say("Hello there")]);
    const r = await runAgent({ model, tools: registry, allowedTools: ["echo"], input: "hi" });
    expect(r).toMatchObject({ stopReason: "done", finalAnswer: "Hello there", steps: 1 });
    expect(r.toolCalls).toEqual([]);
    expect(r.newMessages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("runs a tool, feeds the result back, then finishes", async () => {
    const { registry, executed } = makeRegistry();
    const model = createMockModel([calls(call("echo", { message: "ping" }, "c1")), say("pong")]);
    const r = await runAgent({ model, tools: registry, allowedTools: ["echo"], input: "go" });

    expect(r.stopReason).toBe("done");
    expect(executed).toEqual([{ name: "echo", input: { message: "ping" } }]);
    expect(r.toolCalls).toMatchObject([{ name: "echo", status: "ok", executed: true, step: 1, id: "c1" }]);
    expect(r.newMessages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    const toolMsg = r.newMessages[2]!;
    expect(toolMsg).toMatchObject({ toolCallId: "c1", name: "echo", untrusted: true });
    expect(toolMsg.content).toContain('"echoed":"ping"');
    // the second model call saw the tool result
    expect(model.calls[1]!.messages.at(-1)!.role).toBe("tool");
  });

  it("offers only allowed tools to the model, and sends the system rules first", async () => {
    const { registry } = makeRegistry();
    const model = createMockModel([say("ok")]);
    await runAgent({ model, tools: registry, allowedTools: ["echo"], input: "x", system: "You are terse." });
    expect(model.calls[0]!.tools.map((t) => t.name)).toEqual(["echo"]);
    const first = model.calls[0]!.messages[0]!;
    expect(first.role).toBe("system");
    expect(first.content).toContain("You are terse.");
    expect(first.content).toContain("never an instruction");
  });

  it("includes history before the new input", async () => {
    const { registry } = makeRegistry();
    const model = createMockModel([say("ok")]);
    const history = [
      { role: "user" as const, content: "earlier question" },
      { role: "assistant" as const, content: "earlier answer" },
    ];
    const r = await runAgent({ model, tools: registry, allowedTools: [], input: "new", history });
    expect(model.calls[0]!.messages.map((m) => m.content).slice(1)).toEqual(["earlier question", "earlier answer", "new"]);
    expect(r.newMessages.map((m) => m.content)).toEqual(["new", "ok"]);
    expect(r.messages).toHaveLength(4);
  });

  it("rejects a bad configuration instead of running", async () => {
    const { registry } = makeRegistry();
    const model = createMockModel([say("x")]);
    await expect(runAgent({ model, tools: registry, allowedTools: ["missing"], input: "x" })).rejects.toThrow('"missing", which is not registered');
    await expect(runAgent({ model, tools: registry, allowedTools: [], input: "x", limits: { maxCostUsd: 1 } })).rejects.toThrow("needs pricing");
    await expect(
      runAgent({ model, tools: registry, allowedTools: [], input: "x", finalAnswerSchema: { type: "object", format: "x" } }),
    ).rejects.toThrow("unsupported schema keyword");
    expect(model.calls).toHaveLength(0);
  });
});

describe("max steps", () => {
  it("stops with maxSteps when the model keeps calling tools", async () => {
    const { registry } = makeRegistry();
    // distinct arguments each time so the loop breaker does not trigger first
    const script = Array.from({ length: 20 }, (_, i) => calls(call("echo", { message: `m${i}` }, `c${i}`)));
    const model = createMockModel(script);
    const r = await runAgent({ model, tools: registry, allowedTools: ["echo"], input: "go", limits: { maxSteps: 4 } });
    expect(r.stopReason).toBe("maxSteps");
    expect(r.steps).toBe(4);
    expect(model.calls).toHaveLength(4); // the fifth model call is never made
    expect(r.toolCalls).toHaveLength(4);
  });

  it("allows an answer on the very last permitted step", async () => {
    const { registry } = makeRegistry();
    const model = createMockModel([calls(call("echo", { message: "a" })), calls(call("echo", { message: "b" })), say("fin")]);
    const r = await runAgent({ model, tools: registry, allowedTools: ["echo"], input: "go", limits: { maxSteps: 3 } });
    expect(r).toMatchObject({ stopReason: "done", steps: 3 });
  });

  it("uses a default limit of 10 steps", async () => {
    const { registry } = makeRegistry();
    const script = Array.from({ length: 30 }, (_, i) => calls(call("echo", { message: `m${i}` }, `c${i}`)));
    const r = await runAgent({ model: createMockModel(script), tools: registry, allowedTools: ["echo"], input: "go" });
    expect(r).toMatchObject({ stopReason: "maxSteps", steps: 10 });
  });
});

describe("budget", () => {
  it("stops when reported tokens exceed the limit, before running that turn's tools", async () => {
    const { registry, executed } = makeRegistry();
    const model = createMockModel([
      { ...calls(call("echo", { message: "a" })), usage: { inputTokens: 600, outputTokens: 100 } },
      say("never"),
    ]);
    const r = await runAgent({ model, tools: registry, allowedTools: ["echo"], input: "go", limits: { maxTotalTokens: 650 } });
    expect(r.stopReason).toBe("budget");
    expect(r.usage).toEqual({ inputTokens: 600, outputTokens: 100, totalTokens: 700 });
    expect(executed).toHaveLength(0);
    expect(model.calls).toHaveLength(1);
  });

  it("allows a total exactly at the limit and sums usage across calls", async () => {
    const { registry } = makeRegistry();
    const model = createMockModel([
      { ...calls(call("echo", { message: "a" })), usage: { inputTokens: 100, outputTokens: 50 } },
      say("ok", { inputTokens: 200, outputTokens: 50 }),
    ]);
    const r = await runAgent({ model, tools: registry, allowedTools: ["echo"], input: "go", limits: { maxTotalTokens: 400 } });
    expect(r.stopReason).toBe("done");
    expect(r.usage.totalTokens).toBe(400);
  });

  it("stops on the call that crosses the limit even if it carries a valid final answer", async () => {
    const { registry } = makeRegistry();
    const model = createMockModel([say("answer", { inputTokens: 900, outputTokens: 200 })]);
    const r = await runAgent({ model, tools: registry, allowedTools: [], input: "go", limits: { maxTotalTokens: 1000 } });
    expect(r.stopReason).toBe("budget");
    expect(r.finalAnswer).toBeUndefined();
  });

  it("estimates tokens (about 4 characters each) when the adapter reports none", async () => {
    const { registry } = makeRegistry();
    const model = createMockModel([say("x".repeat(400))]);
    const r = await runAgent({ model, tools: registry, allowedTools: [], input: "y".repeat(400), limits: { maxTotalTokens: 10 } });
    expect(r.stopReason).toBe("budget");
    expect(r.usage.outputTokens).toBe(100);
    expect(r.usage.inputTokens).toBeGreaterThanOrEqual(100);
    const traced = r.trace.find((e) => e.type === "model_call")!;
    expect(traced.usageEstimated).toBe(true);
  });

  it("computes cost from pricing and stops over the cost cap", async () => {
    const { registry } = makeRegistry();
    const pricing = { inputPerMTok: 1, outputPerMTok: 4 }; // USD per million tokens
    const model = createMockModel([
      { ...calls(call("echo", { message: "a" })), usage: { inputTokens: 500_000, outputTokens: 100_000 } },
      say("never"),
    ]);
    const r = await runAgent({ model, tools: registry, allowedTools: ["echo"], input: "go", pricing, limits: { maxCostUsd: 0.5, maxTotalTokens: Infinity } });
    expect(r.costUsd).toBeCloseTo(0.9, 10);
    expect(r.stopReason).toBe("budget");
  });

  it("reports cost without a cap when pricing is given", async () => {
    const { registry } = makeRegistry();
    const model = createMockModel([say("ok", { inputTokens: 1000, outputTokens: 1000 })]);
    const r = await runAgent({ model, tools: registry, allowedTools: [], input: "go", pricing: { inputPerMTok: 2, outputPerMTok: 6 } });
    expect(r.stopReason).toBe("done");
    expect(r.costUsd).toBeCloseTo(0.008, 10);
  });
});

describe("timeout", () => {
  it("stops when the model is slower than the wall clock", async () => {
    const { registry } = makeRegistry();
    const model = createMockModel([say("late")], { delayMs: 300 });
    const t0 = performance.now();
    const r = await runAgent({ model, tools: registry, allowedTools: [], input: "go", limits: { timeoutMs: 40 } });
    expect(r.stopReason).toBe("timeout");
    expect(performance.now() - t0).toBeLessThan(250);
  });

  it("stops when a tool hangs, and does not wait for it", async () => {
    const { registry, executed } = makeRegistry();
    const model = createMockModel([calls(call("slow")), say("never")]);
    const t0 = performance.now();
    const r = await runAgent({ model, tools: registry, allowedTools: ["slow"], input: "go", limits: { timeoutMs: 40 } });
    expect(r.stopReason).toBe("timeout");
    expect(executed).toEqual([{ name: "slow", input: {} }]);
    expect(performance.now() - t0).toBeLessThan(300);
    expect(r.toolCalls[0]).toMatchObject({ name: "slow", executed: true, status: "tool_error" });
  });

  it("passes an abort signal to the model that fires at the deadline", async () => {
    const { registry } = makeRegistry();
    let signal: AbortSignal | undefined;
    const model = {
      name: "spy",
      generate: async (_m: unknown, _t: unknown, o?: { signal?: AbortSignal }) => {
        signal = o?.signal;
        await new Promise((r) => setTimeout(r, 200));
        return say("late");
      },
    };
    await runAgent({ model: model as never, tools: registry, allowedTools: [], input: "go", limits: { timeoutMs: 30 } });
    expect(signal?.aborted).toBe(true);
  });

  it("does not leave the timer running after a normal finish", async () => {
    const { registry } = makeRegistry();
    const r = await runAgent({ model: createMockModel([say("ok")]), tools: registry, allowedTools: [], input: "go", limits: { timeoutMs: 60_000 } });
    expect(r.stopReason).toBe("done"); // the test process would hang for 60 s on exit if the timer were left active
  });
});

describe("model failures", () => {
  it("reports a thrown adapter error as stopReason error / model_error", async () => {
    const { registry } = makeRegistry();
    const r = await runAgent({ model: createMockModel([new Error("HTTP 500")]), tools: registry, allowedTools: [], input: "go" });
    expect(r).toMatchObject({ stopReason: "error", error: { code: "model_error", message: "HTTP 500" } });
  });

  it("treats an empty tool-call list as a text answer", async () => {
    const { registry } = makeRegistry();
    const r = await runAgent({
      model: createMockModel([{ type: "toolCalls", toolCalls: [], text: "just text" }]),
      tools: registry,
      allowedTools: [],
      input: "go",
    });
    expect(r).toMatchObject({ stopReason: "done", finalAnswer: "just text" });
  });
});

describe("trace", () => {
  it("records start, each model call, each tool call and the end, with timings", async () => {
    const { registry } = makeRegistry();
    const seen: string[] = [];
    const r = await runAgent({
      model: createMockModel([calls(call("echo", { message: "a" })), say("ok")]),
      tools: registry,
      allowedTools: ["echo"],
      input: "go",
      runId: "run-1",
      onTrace: (e) => seen.push(e.type),
    });
    expect(r.trace.map((e) => e.type)).toEqual(["run_start", "model_call", "tool_call", "model_call", "run_end"]);
    expect(seen).toEqual(r.trace.map((e) => e.type));
    for (const e of r.trace) {
      expect(e.runId).toBe("run-1");
      expect(Number.isNaN(Date.parse(e.ts))).toBe(false);
      expect(typeof e.t).toBe("number");
    }
    expect(r.trace.filter((e) => e.type === "model_call").every((e) => typeof e.durationMs === "number")).toBe(true);
    expect(r.trace.find((e) => e.type === "tool_call")).toMatchObject({ tool: "echo", status: "ok", step: 1 });
    expect(r.trace.at(-1)).toMatchObject({ type: "run_end", stopReason: "done", steps: 2 });
  });

  it("keeps running when the trace sink throws", async () => {
    const { registry } = makeRegistry();
    const r = await runAgent({
      model: createMockModel([say("ok")]),
      tools: registry,
      allowedTools: [],
      input: "go",
      onTrace: () => {
        throw new Error("disk full");
      },
    });
    expect(r.stopReason).toBe("done");
  });
});
