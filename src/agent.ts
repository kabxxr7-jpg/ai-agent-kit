import { randomUUID } from "node:crypto";
import { assertSchema, validate } from "./schema";
import {
  buildSystemPrompt,
  estimateTokens,
  formatToolResult,
  messagesToText,
  parseJsonText,
  stableStringify,
} from "./format";
import type { ToolRegistry } from "./tools";
import type {
  ErrorCode,
  JsonSchema,
  Limits,
  Message,
  ModelAdapter,
  ModelTurn,
  Pricing,
  RunResult,
  StopReason,
  ToolCallRecord,
  ToolCallStatus,
  TraceEvent,
} from "./types";

export const DEFAULT_LIMITS = {
  maxSteps: 10,
  maxTotalTokens: 50_000,
  timeoutMs: 30_000,
  maxIdenticalCalls: 2,
} as const;

export interface RunOptions {
  model: ModelAdapter;
  tools: ToolRegistry;
  /** Required and explicit: a tool that is not listed here is never offered and never run. */
  allowedTools: string[];
  /** The user's message for this run. */
  input: string;
  system?: string;
  /** Earlier messages (for example from ConversationMemory), without a system message. */
  history?: Message[];
  limits?: Limits;
  pricing?: Pricing;
  /** The model's final text must be JSON that passes this schema. Without it, any text is accepted. */
  finalAnswerSchema?: JsonSchema;
  /** Called for every trace event as it happens. */
  onTrace?: (event: TraceEvent) => void;
  runId?: string;
}

class Timeout extends Error {}

/**
 * Runs one agent turn: ask the model, run the tools it asks for, repeat until it answers, a limit
 * is hit, or a guardrail trips. It does not throw for anything the model or a tool does; the
 * outcome is in `stopReason`. It throws only for a bad configuration (unknown allowed tool, a
 * cost cap without pricing, a malformed final-answer schema).
 */
export async function runAgent(options: RunOptions): Promise<RunResult> {
  const { model, tools, input, pricing, finalAnswerSchema } = options;
  const limits = {
    maxSteps: options.limits?.maxSteps ?? DEFAULT_LIMITS.maxSteps,
    maxTotalTokens: options.limits?.maxTotalTokens ?? DEFAULT_LIMITS.maxTotalTokens,
    maxCostUsd: options.limits?.maxCostUsd,
    timeoutMs: options.limits?.timeoutMs ?? DEFAULT_LIMITS.timeoutMs,
    maxIdenticalCalls: options.limits?.maxIdenticalCalls ?? DEFAULT_LIMITS.maxIdenticalCalls,
  };

  for (const name of options.allowedTools) {
    if (!tools.has(name)) throw new Error(`allowedTools lists "${name}", which is not registered`);
  }
  if (limits.maxCostUsd !== undefined && !pricing) throw new Error("limits.maxCostUsd needs pricing");
  if (finalAnswerSchema) assertSchema(finalAnswerSchema, "finalAnswerSchema");

  const allowed = new Set(options.allowedTools);
  const specs = tools.specs(allowed);
  const runId = options.runId ?? randomUUID();
  const started = performance.now();
  const trace: TraceEvent[] = [];
  const emit = (type: TraceEvent["type"], fields: Record<string, unknown> = {}) => {
    const event: TraceEvent = { type, runId, ts: new Date().toISOString(), t: round(performance.now() - started), ...fields };
    trace.push(event);
    try {
      options.onTrace?.(event);
    } catch {
      // a failing trace sink must not take the run down with it
    }
  };

  const system: Message = { role: "system", content: buildSystemPrompt(options.system, finalAnswerSchema) };
  const added: Message[] = [{ role: "user", content: input }];
  const messages = (): Message[] => [system, ...(options.history ?? []), ...added];

  let steps = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  const records: ToolCallRecord[] = [];
  const callCounts = new Map<string, number>();
  let badCallStreak = 0; // consecutive calls rejected for arguments, unknown tool or allow-list
  let finalAnswerRetries = 0;

  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Timeout());
    }, limits.timeoutMs);
  });
  deadline.catch(() => {}); // a timeout that nobody is awaiting must not become an unhandled rejection
  const race = <T>(p: Promise<T>): Promise<T> => Promise.race([p, deadline]);
  const timedOut = () => performance.now() - started >= limits.timeoutMs;

  emit("run_start", {
    model: model.name,
    allowedTools: [...allowed],
    limits: { ...limits, maxTotalTokens: Number.isFinite(limits.maxTotalTokens) ? limits.maxTotalTokens : null },
  });

  const finish = (stopReason: StopReason, extra: { finalAnswer?: unknown; error?: { code: ErrorCode; message: string } } = {}): RunResult => {
    clearTimeout(timer);
    const durationMs = round(performance.now() - started);
    emit("run_end", { stopReason, steps, durationMs, totalTokens: inputTokens + outputTokens, costUsd, error: extra.error });
    return {
      stopReason,
      ...extra,
      steps,
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      costUsd,
      toolCalls: records,
      messages: messages().slice(1),
      newMessages: added,
      trace,
      durationMs,
    };
  };
  const fail = (code: ErrorCode, message: string, step: number): RunResult => {
    emit("guardrail", { step, code, message });
    return finish("error", { error: { code, message } });
  };

  for (;;) {
    if (timedOut()) return finish("timeout");
    if (steps >= limits.maxSteps) return finish("maxSteps");
    steps++;
    const step = steps;

    // ---- model call
    const prompt = messages();
    const callStart = performance.now();
    let turn: ModelTurn;
    try {
      turn = await race(model.generate(prompt, specs, { signal: ac.signal }));
    } catch (err) {
      if (err instanceof Timeout) return finish("timeout");
      return fail("model_error", errorText(err), step);
    }
    const usage = turn.usage ?? {
      inputTokens: estimateTokens(messagesToText(prompt)),
      outputTokens: estimateTokens(turn.type === "text" ? turn.text : (turn.text ?? "") + JSON.stringify(turn.toolCalls)),
    };
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    if (pricing) costUsd = (inputTokens * pricing.inputPerMTok + outputTokens * pricing.outputPerMTok) / 1_000_000;
    emit("model_call", {
      step,
      durationMs: round(performance.now() - callStart),
      turn: turn.type,
      toolCalls: turn.type === "toolCalls" ? turn.toolCalls.map((c) => c.name) : undefined,
      usage,
      usageEstimated: turn.usage === undefined,
      totalTokens: inputTokens + outputTokens,
      costUsd,
    });

    if (inputTokens + outputTokens > limits.maxTotalTokens) {
      emit("guardrail", { step, code: "budget", message: `token budget ${limits.maxTotalTokens} exceeded` });
      return finish("budget");
    }
    if (limits.maxCostUsd !== undefined && costUsd > limits.maxCostUsd) {
      emit("guardrail", { step, code: "budget", message: `cost budget ${limits.maxCostUsd} USD exceeded` });
      return finish("budget");
    }

    // ---- a text turn is the final answer, if it passes the schema
    if (turn.type === "text" || turn.toolCalls.length === 0) {
      const text = turn.type === "text" ? turn.text : (turn.text ?? "");
      added.push({ role: "assistant", content: text });
      if (!finalAnswerSchema) return finish("done", { finalAnswer: text });

      const parsed = parseJsonText(text);
      const problems = parsed.ok ? validate(finalAnswerSchema, parsed.value) : ["$: not valid JSON"];
      if (parsed.ok && problems.length === 0) return finish("done", { finalAnswer: parsed.value });

      emit("guardrail", { step, code: "invalid_final_answer", problems });
      if (finalAnswerRetries >= 1) {
        return fail("invalid_final_answer", `final answer rejected twice: ${problems.join("; ")}`, step);
      }
      finalAnswerRetries++;
      added.push({
        role: "user",
        content: `Your answer was rejected: ${problems.join("; ")}. Reply again with only a JSON object that matches the schema.`,
      });
      continue;
    }

    // ---- tool calls
    added.push({ role: "assistant", content: turn.text ?? "", toolCalls: turn.toolCalls });
    for (const call of turn.toolCalls) {
      const record = (status: ToolCallStatus, executed: boolean, ms: number, extra: Record<string, unknown> = {}) => {
        records.push({ step, id: call.id, name: call.name, arguments: call.arguments, status, executed, durationMs: ms });
        emit("tool_call", { step, callId: call.id, tool: call.name, arguments: call.arguments, status, executed, durationMs: ms, ...extra });
      };
      const reject = (status: ToolCallStatus, code: ErrorCode, message: string, details?: string[]): RunResult | undefined => {
        record(status, false, 0, { message });
        added.push(formatToolResult(call, "error", { error: { code: status, message, details } }));
        badCallStreak++;
        // First rejection is fed back so the model can correct itself; a second in a row aborts.
        if (badCallStreak >= 2) return fail(code, `${message} (second rejected call in a row)`, step);
        emit("guardrail", { step, code, message, fedBack: true });
        return undefined;
      };

      if (!tools.has(call.name)) {
        const out = reject("unknown_tool", "unknown_tool", `no tool named "${call.name}"`);
        if (out) return out;
        continue;
      }
      if (!allowed.has(call.name)) {
        const out = reject("tool_not_allowed", "tool_not_allowed", `tool "${call.name}" is not available in this run`);
        if (out) return out;
        continue;
      }

      const signature = `${call.name}:${stableStringify(call.arguments)}`;
      const seen = callCounts.get(signature) ?? 0;
      if (seen >= limits.maxIdenticalCalls) {
        record("repeated_call", false, 0);
        added.push(formatToolResult(call, "error", { error: { code: "repeated_call", message: "identical call repeated too often" } }));
        return fail("repeated_call", `"${call.name}" called with identical arguments ${seen + 1} times`, step);
      }

      const execStart = performance.now();
      let outcome;
      try {
        outcome = await race(tools.execute(call.name, call.arguments, { signal: ac.signal }));
      } catch (err) {
        if (err instanceof Timeout) {
          record("tool_error", true, round(performance.now() - execStart), { message: "timed out" });
          return finish("timeout");
        }
        throw err;
      }
      const ms = round(performance.now() - execStart);

      if (!outcome.ok && outcome.error.code === "invalid_arguments") {
        const out = reject("invalid_arguments", "invalid_arguments", outcome.error.message, outcome.error.details);
        if (out) return out;
        continue;
      }

      callCounts.set(signature, seen + 1);
      badCallStreak = 0;
      if (outcome.ok) {
        record("ok", true, ms);
        added.push(formatToolResult(call, "ok", outcome.output));
      } else {
        const status: ToolCallStatus = outcome.error.code === "invalid_output" ? "invalid_output" : "tool_error";
        record(status, true, ms, { message: outcome.error.message });
        added.push(formatToolResult(call, "error", { error: outcome.error }));
      }
    }
  }
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}
