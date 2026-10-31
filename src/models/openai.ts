import { AdapterError, type AdapterOptions } from "./common";
import type { GenerateOptions, Message, ModelAdapter, ModelTurn, ToolCall, ToolSpec } from "../types";

export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * Plain-fetch adapter for the Chat Completions endpoint with tools. The key goes in the
 * Authorization header and is never logged or put in an error message. NOT run against the live
 * API in this build: request and response shapes are checked only against a fake fetch, written
 * from the public documentation.
 */
export function createOpenAIModel(options: AdapterOptions = {}): ModelAdapter {
  const model = options.model ?? DEFAULT_OPENAI_MODEL;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = options.timeoutMs ?? 60_000;

  return {
    name: `openai (${model})`,
    async generate(messages: Message[], tools: ToolSpec[], gen: GenerateOptions = {}): Promise<ModelTurn> {
      const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
      if (!apiKey) throw new AdapterError("OPENAI_API_KEY is not set.", "not_configured");
      const doFetch = options.fetch ?? fetch;

      const signals = [AbortSignal.timeout(timeoutMs), ...(gen.signal ? [gen.signal] : [])];
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(buildOpenAIRequest(model, messages, tools)),
          signal: AbortSignal.any(signals),
        });
      } catch (err) {
        throw new AdapterError(`OpenAI request failed (${err instanceof Error ? err.name : "unknown error"}).`, "api_error");
      }
      if (!response.ok) {
        if (response.status === 429) throw new AdapterError("OpenAI is rate-limited right now.", "rate_limit");
        throw new AdapterError(`OpenAI API error (${response.status}).`, "api_error");
      }
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        throw new AdapterError("OpenAI returned a body that was not JSON.", "invalid_output");
      }
      return parseOpenAIResponse(json);
    },
  };
}

export function buildOpenAIRequest(model: string, messages: Message[], tools: ToolSpec[]): Record<string, unknown> {
  const wire = messages.map((m) => {
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
        })),
      };
    }
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    return { role: m.role, content: m.content };
  });
  return {
    model,
    messages: wire,
    ...(tools.length > 0
      ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }
      : {}),
  };
}

export function parseOpenAIResponse(json: unknown): ModelTurn {
  const body = json as {
    choices?: { message?: { content?: unknown; tool_calls?: { id?: unknown; function?: { name?: unknown; arguments?: unknown } }[] } }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  } | null;
  const message = body?.choices?.[0]?.message;
  if (!message) throw new AdapterError("OpenAI did not return any output.", "invalid_output");

  const u = body?.usage;
  const usage =
    typeof u?.prompt_tokens === "number" && typeof u?.completion_tokens === "number"
      ? { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens }
      : undefined;
  const text = typeof message.content === "string" ? message.content : "";

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    const toolCalls: ToolCall[] = message.tool_calls.map((c, i) => {
      let args: unknown = {};
      const raw = c.function?.arguments;
      if (typeof raw === "string" && raw.trim() !== "") {
        try {
          args = JSON.parse(raw);
        } catch {
          args = raw; // not JSON: leave it as a string so the tool's input schema rejects it
        }
      }
      return {
        id: typeof c.id === "string" ? c.id : `call_${i + 1}`,
        name: typeof c.function?.name === "string" ? c.function.name : "",
        arguments: args,
      };
    });
    return { type: "toolCalls", toolCalls, ...(text ? { text } : {}), ...(usage ? { usage } : {}) };
  }
  if (!text) throw new AdapterError("OpenAI did not return any output.", "invalid_output");
  return { type: "text", text, ...(usage ? { usage } : {}) };
}
