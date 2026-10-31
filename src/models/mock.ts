import type { GenerateOptions, Message, ModelAdapter, ModelTurn, ToolCall, ToolSpec, Usage } from "../types";

/** A scripted step: a turn, an Error to throw, or a function that computes either. */
export type MockStep =
  | ModelTurn
  | Error
  | ((messages: Message[], tools: ToolSpec[]) => ModelTurn | Error | Promise<ModelTurn | Error>);

export interface MockCall {
  messages: Message[];
  tools: ToolSpec[];
}

export interface MockModel extends ModelAdapter {
  readonly calls: MockCall[];
}

export interface MockOptions {
  name?: string;
  /** Wait this long before every answer (to test timeouts). Honors the abort signal. */
  delayMs?: number;
}

/**
 * Returns the scripted steps in order, one per `generate` call, and records what it was sent.
 * For tests and offline examples only: it says nothing about how a real model behaves.
 */
export function createMockModel(script: MockStep[], options: MockOptions = {}): MockModel {
  const calls: MockCall[] = [];
  return {
    name: options.name ?? "mock",
    calls,
    async generate(messages: Message[], tools: ToolSpec[], gen: GenerateOptions = {}): Promise<ModelTurn> {
      calls.push({ messages: structuredClone(messages), tools: structuredClone(tools) });
      if (options.delayMs) await sleep(options.delayMs, gen.signal);
      if (calls.length > script.length) throw new Error(`mock model script exhausted after ${script.length} call(s)`);
      let step = script[calls.length - 1]!;
      if (typeof step === "function") step = await step(messages, tools);
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

// ---- scenario files: compact JSON turns -> ModelTurn

/** One scripted turn as written in a scenario file. */
export interface MockTurnSpec {
  /** Text answer. An object is sent as JSON text, which is how a final answer normally arrives. */
  text?: unknown;
  toolCalls?: { name: string; arguments?: unknown }[];
  usage?: Usage;
  /** Throw this message from the model call. */
  error?: string;
  delayMs?: number;
}

export function turnsFromSpecs(specs: MockTurnSpec[]): { script: MockStep[]; delayMs: number } {
  let n = 0;
  const script: MockStep[] = specs.map((s) => {
    if (s.error !== undefined) return new Error(s.error);
    if (s.toolCalls && s.toolCalls.length > 0) {
      const toolCalls: ToolCall[] = s.toolCalls.map((c) => ({ id: `call_${++n}`, name: c.name, arguments: c.arguments ?? {} }));
      return { type: "toolCalls", toolCalls, ...(s.usage ? { usage: s.usage } : {}) };
    }
    const text = typeof s.text === "string" ? s.text : JSON.stringify(s.text ?? "");
    return { type: "text", text, ...(s.usage ? { usage: s.usage } : {}) };
  });
  return { script, delayMs: Math.max(0, ...specs.map((s) => s.delayMs ?? 0)) };
}
