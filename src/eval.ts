import { readFileSync } from "node:fs";
import { createMockModel, turnsFromSpecs, type MockTurnSpec } from "./models/mock";
import { runSupportAgent } from "./demo/support-agent";
import { SupportStore } from "./demo/store";
import type { ErrorCode, Limits, ModelAdapter, RunResult, StopReason, ToolCallStatus, TraceEvent } from "./types";

export interface ExpectedToolCall {
  name: string;
  /** Partial match: every key given here must be equal in the actual arguments. */
  arguments?: Record<string, unknown>;
}

export interface Expectation {
  /** Default "done". */
  stopReason?: StopReason;
  errorCode?: ErrorCode;
  /** The tool calls that were executed, in order. Arguments are matched partially. Exact length. */
  toolCalls?: ExpectedToolCall[];
  /** Tools that must not have been executed. */
  notExecuted?: string[];
  /** Tool calls that the guardrails must have refused, by name and status. */
  refused?: { name: string; status: ToolCallStatus }[];
  /** Partial match against the final answer object. */
  finalAnswer?: Record<string, unknown>;
  /** Support store: how many tickets must exist at the end. */
  ticketCount?: number;
  maxSteps?: number;
}

export interface Scenario {
  id: string;
  description?: string;
  input: string;
  allowedTools?: string[];
  limits?: Limits;
  /** Scripted model turns, used with --model mock. Ignored for real models. */
  mockTurns: MockTurnSpec[];
  expect: Expectation;
}

export interface ScenarioResult {
  id: string;
  passed: boolean;
  failures: string[];
  stopReason: StopReason;
  steps: number;
  toolCalls: number;
  durationMs: number;
}

export function parseScenarios(text: string): Scenario[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("scenario file is not valid JSON");
  }
  const list = (data as { scenarios?: unknown })?.scenarios;
  if (!Array.isArray(list) || list.length === 0) throw new Error('scenario file must be {"scenarios": [ ... ]} with at least one scenario');
  const seen = new Set<string>();
  return list.map((raw, i) => {
    const s = raw as Partial<Scenario>;
    const where = `scenario #${i + 1}${typeof s?.id === "string" ? ` (${s.id})` : ""}`;
    if (typeof s?.id !== "string" || s.id === "") throw new Error(`${where}: id is required`);
    if (seen.has(s.id)) throw new Error(`${where}: duplicate id`);
    seen.add(s.id);
    if (typeof s.input !== "string" || s.input === "") throw new Error(`${where}: input is required`);
    if (!Array.isArray(s.mockTurns)) throw new Error(`${where}: mockTurns must be an array`);
    if (typeof s.expect !== "object" || s.expect === null) throw new Error(`${where}: expect is required`);
    return s as Scenario;
  });
}

export function loadScenarios(path: string): Scenario[] {
  return parseScenarios(readFileSync(path, "utf8"));
}

/** True when every key and element named in `expected` is present and equal in `actual`. */
export function matchesSubset(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length && expected.every((e, i) => matchesSubset(e, actual[i]));
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([k, v]) => matchesSubset(v, (actual as Record<string, unknown>)[k]));
  }
  return expected === actual;
}

export function checkExpectation(expect: Expectation, run: RunResult): string[] {
  const failures: string[] = [];
  const wantStop = expect.stopReason ?? "done";
  if (run.stopReason !== wantStop) {
    failures.push(`stopReason: expected ${wantStop}, got ${run.stopReason}${run.error ? ` (${run.error.code})` : ""}`);
  }
  if (expect.errorCode !== undefined && run.error?.code !== expect.errorCode) {
    failures.push(`errorCode: expected ${expect.errorCode}, got ${run.error?.code ?? "none"}`);
  }
  const executed = run.toolCalls.filter((c) => c.executed);
  if (expect.toolCalls) {
    const got = executed.map((c) => c.name).join(", ") || "none";
    if (executed.length !== expect.toolCalls.length) {
      failures.push(`toolCalls: expected ${expect.toolCalls.length} executed call(s) [${expect.toolCalls.map((c) => c.name).join(", ")}], got ${executed.length} [${got}]`);
    } else {
      expect.toolCalls.forEach((want, i) => {
        const have = executed[i]!;
        if (have.name !== want.name) failures.push(`toolCalls[${i}]: expected ${want.name}, got ${have.name}`);
        else if (want.arguments && !matchesSubset(want.arguments, have.arguments)) {
          failures.push(`toolCalls[${i}] (${want.name}): arguments ${JSON.stringify(have.arguments)} do not contain ${JSON.stringify(want.arguments)}`);
        }
      });
    }
  }
  for (const name of expect.notExecuted ?? []) {
    if (executed.some((c) => c.name === name)) failures.push(`notExecuted: ${name} was executed`);
  }
  for (const want of expect.refused ?? []) {
    if (!run.toolCalls.some((c) => c.name === want.name && c.status === want.status && !c.executed)) {
      failures.push(`refused: expected a refused ${want.name} call with status ${want.status}`);
    }
  }
  if (expect.finalAnswer && !matchesSubset(expect.finalAnswer, run.finalAnswer)) {
    failures.push(`finalAnswer: ${JSON.stringify(run.finalAnswer)} does not contain ${JSON.stringify(expect.finalAnswer)}`);
  }
  if (expect.maxSteps !== undefined && run.steps > expect.maxSteps) {
    failures.push(`steps: expected at most ${expect.maxSteps}, used ${run.steps}`);
  }
  return failures;
}

export interface RunScenariosOptions {
  /** Builds the model for a scenario. Defaults to the scripted mock from `mockTurns`. */
  makeModel?: (scenario: Scenario) => ModelAdapter;
  onTrace?: (event: TraceEvent) => void;
  /** Called after each scenario, for streaming output. */
  onResult?: (result: ScenarioResult) => void;
}

export async function runScenarios(scenarios: Scenario[], options: RunScenariosOptions = {}): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    const store = new SupportStore(); // fresh, identical data for every scenario
    let model: ModelAdapter;
    if (options.makeModel) model = options.makeModel(scenario);
    else {
      const { script, delayMs } = turnsFromSpecs(scenario.mockTurns);
      model = createMockModel(script, { delayMs });
    }
    let run: RunResult;
    let failures: string[];
    try {
      run = await runSupportAgent({
        model,
        input: scenario.input,
        store,
        allowedTools: scenario.allowedTools,
        limits: scenario.limits,
        onTrace: (e) => options.onTrace?.({ ...e, scenarioId: scenario.id }),
        runId: scenario.id,
      });
      failures = checkExpectation(scenario.expect, run);
      if (scenario.expect.ticketCount !== undefined && store.tickets.length !== scenario.expect.ticketCount) {
        failures.push(`ticketCount: expected ${scenario.expect.ticketCount}, got ${store.tickets.length}`);
      }
      if (store.destructiveCalls.length > 0 && !(scenario.allowedTools ?? []).includes("delete_all")) {
        failures.push(`a destructive operation ran: ${store.destructiveCalls.join(", ")}`);
      }
    } catch (err) {
      const result: ScenarioResult = {
        id: scenario.id,
        passed: false,
        failures: [`runner threw: ${err instanceof Error ? err.message : String(err)}`],
        stopReason: "error",
        steps: 0,
        toolCalls: 0,
        durationMs: 0,
      };
      results.push(result);
      options.onResult?.(result);
      continue;
    }
    const result: ScenarioResult = {
      id: scenario.id,
      passed: failures.length === 0,
      failures,
      stopReason: run.stopReason,
      steps: run.steps,
      toolCalls: run.toolCalls.filter((c) => c.executed).length,
      durationMs: run.durationMs,
    };
    results.push(result);
    options.onResult?.(result);
  }
  return results;
}

export function formatResult(r: ScenarioResult): string {
  const head = `${r.passed ? "PASS" : "FAIL"}  ${r.id}  (${r.steps} step${r.steps === 1 ? "" : "s"}, ${r.toolCalls} tool call${r.toolCalls === 1 ? "" : "s"}, stop=${r.stopReason}, ${Math.round(r.durationMs)} ms)`;
  return r.passed ? head : [head, ...r.failures.map((f) => `      - ${f}`)].join("\n");
}

export function formatSummary(results: ScenarioResult[], modelName: string): string {
  const passed = results.filter((r) => r.passed).length;
  return `Summary: ${passed} passed, ${results.length - passed} failed, ${results.length} scenarios (model: ${modelName})`;
}
