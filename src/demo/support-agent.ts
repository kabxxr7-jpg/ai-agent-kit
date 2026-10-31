import { runAgent } from "../agent";
import type { JsonSchema, Limits, Message, ModelAdapter, RunResult, TraceEvent } from "../types";
import { SupportStore } from "./store";
import { createSupportRegistry, SUPPORT_TOOL_NAMES } from "./tools";

export const SUPPORT_SYSTEM = [
  "You are a support agent for a fictional online shop.",
  "Look up the order before answering anything about it. Use check_refund_eligibility for refund questions.",
  "If you cannot settle the request with the tools, open a support ticket.",
  "Never promise a refund that the eligibility check does not allow.",
].join(" ");

export const SUPPORT_ANSWER_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    resolution: { type: "string", enum: ["refund_eligible", "refund_denied", "ticket_created", "info_provided"] },
    summary: { type: "string", minLength: 1, maxLength: 500 },
    orderId: { type: "string", pattern: "^ORD-[0-9]{4}$" },
    ticketId: { type: "string", pattern: "^TCK-[0-9]{4}$" },
  },
  required: ["resolution", "summary"],
  additionalProperties: false,
};

export interface SupportRunOptions {
  model: ModelAdapter;
  input: string;
  store?: SupportStore;
  /** Overrides the default allow-list (the three support tools). */
  allowedTools?: string[];
  limits?: Limits;
  history?: Message[];
  onTrace?: (e: TraceEvent) => void;
  runId?: string;
}

/** The demo "support agent": three tools over an in-memory store, a final-answer schema, and guardrails on. */
export function runSupportAgent(options: SupportRunOptions): Promise<RunResult> {
  const store = options.store ?? new SupportStore();
  return runAgent({
    model: options.model,
    tools: createSupportRegistry(store),
    allowedTools: options.allowedTools ?? SUPPORT_TOOL_NAMES,
    input: options.input,
    system: SUPPORT_SYSTEM,
    history: options.history,
    finalAnswerSchema: SUPPORT_ANSWER_SCHEMA,
    limits: options.limits,
    onTrace: options.onTrace,
    runId: options.runId,
  });
}
