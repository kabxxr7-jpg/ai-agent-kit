import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkExpectation, formatResult, formatSummary, loadScenarios, matchesSubset, parseScenarios, runScenarios, type Scenario } from "../src/eval";
import { createMockModel } from "../src/models/mock";
import { createJsonlTrace, readJsonlTrace } from "../src/trace";
import type { RunResult, TraceEvent } from "../src/types";

const SCENARIO_FILE = resolve(__dirname, "../examples/scenarios.json");
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "agent-kit-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const fakeRun = (over: Partial<RunResult> = {}): RunResult => ({
  stopReason: "done",
  steps: 2,
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  costUsd: 0,
  toolCalls: [{ step: 1, id: "c1", name: "lookup_order", arguments: { orderId: "ORD-1001", extra: true }, status: "ok", executed: true, durationMs: 1 }],
  messages: [],
  newMessages: [],
  trace: [],
  durationMs: 3,
  finalAnswer: { resolution: "info_provided", summary: "x" },
  ...over,
});

describe("matchesSubset", () => {
  it("matches partial objects, exact arrays and primitives", () => {
    expect(matchesSubset({ a: 1 }, { a: 1, b: 2 })).toBe(true);
    expect(matchesSubset({ a: 2 }, { a: 1 })).toBe(false);
    expect(matchesSubset({ a: 1, b: 2 }, { a: 1, b: 3 })).toBe(false); // every key must match, not just one
    expect(matchesSubset({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    expect(matchesSubset({ a: { b: 1 } }, { a: { b: 1, c: 2 } })).toBe(true);
    expect(matchesSubset([1, 2], [1, 2])).toBe(true);
    expect(matchesSubset([1], [1, 2])).toBe(false);
    expect(matchesSubset({ a: 1 }, null)).toBe(false);
    expect(matchesSubset({ a: 1 }, [1])).toBe(false);
    expect(matchesSubset("x", "x")).toBe(true);
  });
});

describe("parseScenarios", () => {
  const ok = { id: "a", input: "hi", mockTurns: [], expect: {} };
  it("accepts a valid file", () => {
    expect(parseScenarios(JSON.stringify({ scenarios: [ok] }))).toHaveLength(1);
  });
  it("explains what is wrong", () => {
    expect(() => parseScenarios("{oops")).toThrow("not valid JSON");
    expect(() => parseScenarios("{}")).toThrow("at least one scenario");
    expect(() => parseScenarios(JSON.stringify({ scenarios: [{ ...ok, id: "" }] }))).toThrow("id is required");
    expect(() => parseScenarios(JSON.stringify({ scenarios: [{ ...ok, input: undefined }] }))).toThrow("(a): input is required");
    expect(() => parseScenarios(JSON.stringify({ scenarios: [{ ...ok, mockTurns: "x" }] }))).toThrow("mockTurns must be an array");
    expect(() => parseScenarios(JSON.stringify({ scenarios: [{ ...ok, expect: undefined }] }))).toThrow("expect is required");
    expect(() => parseScenarios(JSON.stringify({ scenarios: [ok, ok] }))).toThrow("duplicate id");
  });
});

describe("checkExpectation", () => {
  it("passes when everything matches (default stopReason is done)", () => {
    expect(
      checkExpectation(
        { toolCalls: [{ name: "lookup_order", arguments: { orderId: "ORD-1001" } }], finalAnswer: { resolution: "info_provided" }, maxSteps: 2 },
        fakeRun(),
      ),
    ).toEqual([]);
  });

  it("reports each kind of mismatch", () => {
    const f = checkExpectation(
      {
        stopReason: "maxSteps",
        errorCode: "repeated_call",
        toolCalls: [{ name: "check_refund_eligibility" }],
        notExecuted: ["lookup_order"],
        refused: [{ name: "delete_all", status: "tool_not_allowed" }],
        finalAnswer: { resolution: "refund_eligible" },
        maxSteps: 1,
      },
      fakeRun(),
    );
    expect(f).toHaveLength(7);
    expect(f.join("\n")).toContain("stopReason: expected maxSteps, got done");
    expect(f.join("\n")).toContain("toolCalls[0]: expected check_refund_eligibility, got lookup_order");
    expect(f.join("\n")).toContain("notExecuted: lookup_order was executed");
    expect(f.join("\n")).toContain("steps: expected at most 1, used 2");
  });

  it("checks the number of executed calls and argument subsets", () => {
    expect(checkExpectation({ toolCalls: [] }, fakeRun())[0]).toContain("expected 0 executed call(s)");
    expect(checkExpectation({ toolCalls: [{ name: "lookup_order", arguments: { orderId: "ORD-2" } }] }, fakeRun())[0]).toContain("do not contain");
  });

  it("does not count refused calls as executed, and finds them by status", () => {
    const run = fakeRun({
      toolCalls: [{ step: 1, id: "x", name: "delete_all", arguments: {}, status: "tool_not_allowed", executed: false, durationMs: 0 }],
      stopReason: "done",
    });
    expect(checkExpectation({ toolCalls: [], notExecuted: ["delete_all"], refused: [{ name: "delete_all", status: "tool_not_allowed" }] }, run)).toEqual([]);
  });
});

describe("runScenarios", () => {
  it("runs the bundled scenario file with the scripted mock: all pass", async () => {
    const scenarios = loadScenarios(SCENARIO_FILE);
    expect(scenarios.length).toBeGreaterThanOrEqual(12);
    const results = await runScenarios(scenarios);
    const failed = results.filter((r) => !r.passed);
    expect(failed.map((r) => `${r.id}: ${r.failures.join("; ")}`)).toEqual([]);
    expect(results).toHaveLength(scenarios.length);
  });

  it("covers every stop reason and every guardrail at least once", () => {
    const scenarios = loadScenarios(SCENARIO_FILE);
    const stops = new Set(scenarios.map((s) => s.expect.stopReason ?? "done"));
    expect([...stops].sort()).toEqual(["budget", "done", "error", "maxSteps", "timeout"]);
    const codes = new Set(scenarios.map((s) => s.expect.errorCode).filter(Boolean));
    expect([...codes].sort()).toEqual(["invalid_arguments", "invalid_final_answer", "model_error", "repeated_call"]);
    expect(scenarios.some((s) => s.expect.refused?.some((r) => r.status === "tool_not_allowed"))).toBe(true);
  });

  it("marks a scenario as failed, with the reason, when the behaviour differs", async () => {
    const scenario: Scenario = {
      id: "wrong-expectation",
      input: "Status of ORD-1001?",
      mockTurns: [{ text: { resolution: "info_provided", summary: "ok" } }],
      expect: { toolCalls: [{ name: "lookup_order" }] },
    };
    const [r] = await runScenarios([scenario]);
    expect(r).toMatchObject({ id: "wrong-expectation", passed: false });
    expect(r!.failures[0]).toContain("expected 1 executed call(s)");
    expect(formatResult(r!)).toMatch(/^FAIL {2}wrong-expectation/);
    expect(formatResult(r!)).toContain("      - toolCalls");
  });

  it("does not flag delete_all when the scenario explicitly allows it", async () => {
    const scenario: Scenario = {
      id: "allowed-delete",
      input: "x",
      allowedTools: ["delete_all"],
      mockTurns: [{ toolCalls: [{ name: "delete_all" }] }, { text: { resolution: "info_provided", summary: "ok" } }],
      expect: { toolCalls: [{ name: "delete_all" }] },
    };
    const [r] = await runScenarios([scenario]);
    expect(r!.passed).toBe(true);
  });

  it("reports a thrown runner error as a failure instead of crashing", async () => {
    const scenario: Scenario = { id: "bad-config", input: "x", allowedTools: ["nonexistent"], mockTurns: [], expect: {} };
    const [r] = await runScenarios([scenario]);
    expect(r).toMatchObject({ passed: false });
    expect(r!.failures[0]).toContain("runner threw");
  });

  it("accepts a custom model factory (used for real models)", async () => {
    const scenario: Scenario = { id: "custom", input: "x", mockTurns: [], expect: { finalAnswer: { resolution: "info_provided" } } };
    const [r] = await runScenarios([scenario], {
      makeModel: () => createMockModel([{ type: "text", text: JSON.stringify({ resolution: "info_provided", summary: "fine" }) }]),
    });
    expect(r!.passed).toBe(true);
  });

  it("gives every scenario fresh data: a ticket from one does not leak into the next", async () => {
    const make = (id: string): Scenario => ({
      id,
      input: "x",
      mockTurns: [
        { toolCalls: [{ name: "create_support_ticket", arguments: { subject: "abc", body: "def", priority: "low" } }] },
        { text: { resolution: "ticket_created", ticketId: "TCK-0001", summary: "ok" } },
      ],
      expect: { ticketCount: 1, finalAnswer: { ticketId: "TCK-0001" } },
    });
    const results = await runScenarios([make("one"), make("two")]);
    expect(results.map((r) => r.passed)).toEqual([true, true]);
  });

  it("formats a summary line", async () => {
    const results = await runScenarios(loadScenarios(SCENARIO_FILE).slice(0, 2));
    expect(formatSummary(results, "mock (scripted)")).toBe("Summary: 2 passed, 0 failed, 2 scenarios (model: mock (scripted))");
  });
});

describe("trace log", () => {
  it("writes one JSON line per event, tagged with the scenario, with timings", async () => {
    const path = join(tmp(), "sub", "trace.jsonl");
    const sink = createJsonlTrace(path, { reset: true });
    const scenarios = loadScenarios(SCENARIO_FILE).filter((s) => s.id === "refund-eligible" || s.id === "bad-arguments-recovers");
    await runScenarios(scenarios, { onTrace: sink });

    const raw = readFileSync(path, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines.every((l) => JSON.parse(l))).toBe(true);
    const events = readJsonlTrace(path) as (TraceEvent & { scenarioId: string })[];
    expect(new Set(events.map((e) => e.scenarioId))).toEqual(new Set(["refund-eligible", "bad-arguments-recovers"]));
    const first = events.filter((e) => e.scenarioId === "refund-eligible");
    expect(first.map((e) => e.type)).toEqual(["run_start", "model_call", "tool_call", "model_call", "tool_call", "model_call", "run_end"]);
    for (const e of events.filter((x) => x.type === "model_call" || x.type === "tool_call")) {
      expect(typeof e.durationMs).toBe("number");
      expect(e.durationMs).toBeGreaterThanOrEqual(0);
    }
    const guard = events.filter((e) => e.scenarioId === "bad-arguments-recovers" && e.type === "guardrail");
    expect(guard).toHaveLength(1);
    expect(guard[0]).toMatchObject({ code: "invalid_arguments", fedBack: true });
    // timestamps never go backwards within a run
    const ts = first.map((e) => e.t);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });

  it("appends across calls unless reset is set", () => {
    const path = join(tmp(), "t.jsonl");
    const ev = { type: "run_start", runId: "r", ts: new Date().toISOString(), t: 0 } as TraceEvent;
    createJsonlTrace(path, { reset: true })(ev);
    createJsonlTrace(path)(ev);
    expect(readJsonlTrace(path)).toHaveLength(2);
    createJsonlTrace(path, { reset: true });
    expect(readJsonlTrace(path)).toHaveLength(0);
  });
});
