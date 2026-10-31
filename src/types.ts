export type JsonSchema = Record<string, unknown>;

export interface ToolCall {
  id: string;
  name: string;
  /** Whatever the model sent. It is untrusted until the tool's input schema accepts it. */
  arguments: unknown;
}

export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: string;
  /** Set on assistant messages that request tools. */
  toolCalls?: ToolCall[];
  /** Set on tool messages: which call this answers. */
  toolCallId?: string;
  /** Set on tool messages: the tool's name. */
  name?: string;
  /** True when the content came from outside the harness (tool output, summaries of it). */
  untrusted?: boolean;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** What a model adapter returns: plain text (the answer) or a list of tool calls. */
export type ModelTurn =
  | { type: "text"; text: string; usage?: Usage }
  | { type: "toolCalls"; toolCalls: ToolCall[]; text?: string; usage?: Usage };

/** What the model is told about a tool. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface GenerateOptions {
  /** Aborted when the run's wall-clock budget is spent. Adapters pass it to fetch. */
  signal?: AbortSignal;
}

/** The only vendor-specific seam. Throwing means the call failed (network, quota, auth). */
export interface ModelAdapter {
  readonly name: string;
  generate(messages: Message[], tools: ToolSpec[], options?: GenerateOptions): Promise<ModelTurn>;
}

export type StopReason = "done" | "maxSteps" | "budget" | "timeout" | "error";

export type ErrorCode =
  | "invalid_arguments"
  | "unknown_tool"
  | "tool_not_allowed"
  | "repeated_call"
  | "invalid_final_answer"
  | "model_error";

export interface Pricing {
  /** USD per one million input tokens. */
  inputPerMTok: number;
  /** USD per one million output tokens. */
  outputPerMTok: number;
}

export interface Limits {
  /** Model calls. Default 10. */
  maxSteps?: number;
  /** Input plus output tokens summed over all calls. Default 50000. Use Infinity to disable. */
  maxTotalTokens?: number;
  /** Needs `pricing`. */
  maxCostUsd?: number;
  /** Wall clock for the whole run, model and tools. Default 30000. */
  timeoutMs?: number;
  /** How many times an identical tool call (same name, same arguments) may run. Default 2. */
  maxIdenticalCalls?: number;
}

export type ToolCallStatus =
  | "ok"
  | "tool_error"
  | "invalid_output"
  | "invalid_arguments"
  | "unknown_tool"
  | "tool_not_allowed"
  | "repeated_call";

export interface ToolCallRecord {
  step: number;
  id: string;
  name: string;
  arguments: unknown;
  status: ToolCallStatus;
  /** True only when the tool's execute function was called. */
  executed: boolean;
  durationMs: number;
}

export interface TraceEvent {
  type: "run_start" | "model_call" | "tool_call" | "guardrail" | "run_end";
  runId: string;
  /** ISO timestamp. */
  ts: string;
  /** Milliseconds since the run started. */
  t: number;
  step?: number;
  durationMs?: number;
  [key: string]: unknown;
}

export interface RunResult {
  stopReason: StopReason;
  /** Parsed and validated when a final-answer schema was given, otherwise the model's text. */
  finalAnswer?: unknown;
  error?: { code: ErrorCode; message: string };
  steps: number;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  costUsd: number;
  toolCalls: ToolCallRecord[];
  /** The history passed in plus everything added during the run. */
  messages: Message[];
  /** Only what this run added (user input, model turns, tool results). */
  newMessages: Message[];
  trace: TraceEvent[];
  durationMs: number;
}
