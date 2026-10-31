import { AdapterError, type AdapterOptions } from "./common";
import type { GenerateOptions, Message, ModelAdapter, ModelTurn, ToolCall, ToolSpec } from "../types";

export const DEFAULT_GEMINI_MODEL = "gemini-flash-lite-latest";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Plain-fetch adapter for Gemini's generateContent endpoint with function calling. The key goes
 * in the x-goog-api-key header, never the URL, and is never logged or put in an error message.
 * NOT run against the live API in this build: the request and response shapes are checked only
 * against a fake fetch, written from the public documentation.
 */
export function createGeminiModel(options: AdapterOptions = {}): ModelAdapter {
  const model = options.model ?? DEFAULT_GEMINI_MODEL;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = options.timeoutMs ?? 60_000;

  return {
    name: `gemini (${model})`,
    async generate(messages: Message[], tools: ToolSpec[], gen: GenerateOptions = {}): Promise<ModelTurn> {
      const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
      if (!apiKey) throw new AdapterError("GEMINI_API_KEY is not set.", "not_configured");
      const doFetch = options.fetch ?? fetch;

      const body = buildGeminiRequest(messages, tools);
      const signals = [AbortSignal.timeout(timeoutMs), ...(gen.signal ? [gen.signal] : [])];
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.any(signals),
        });
      } catch (err) {
        throw new AdapterError(`Gemini request failed (${err instanceof Error ? err.name : "unknown error"}).`, "api_error");
      }
      if (!response.ok) {
        if (response.status === 429) throw new AdapterError("Gemini is rate-limited right now.", "rate_limit");
        throw new AdapterError(`Gemini API error (${response.status}).`, "api_error");
      }
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        throw new AdapterError("Gemini returned a body that was not JSON.", "invalid_output");
      }
      return parseGeminiResponse(json);
    },
  };
}

export function buildGeminiRequest(messages: Message[], tools: ToolSpec[]): Record<string, unknown> {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const contents: { role: string; parts: unknown[] }[] = [];
  const push = (role: string, part: unknown) => {
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(part);
    else contents.push({ role, parts: [part] });
  };
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") push("user", { text: m.content });
    else if (m.role === "assistant") {
      if (m.content) push("model", { text: m.content });
      for (const c of m.toolCalls ?? []) push("model", { functionCall: { name: c.name, args: c.arguments } });
    } else {
      // The wrapped, escaped tool output is sent as-is so the untrusted marking survives.
      push("user", { functionResponse: { name: m.name ?? "tool", response: { result: m.content } } });
    }
  }
  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents,
    ...(tools.length > 0
      ? {
          tools: [
            {
              functionDeclarations: tools.map((t) => ({
                name: t.name,
                description: t.description,
                parametersJsonSchema: t.inputSchema,
              })),
            },
          ],
        }
      : {}),
  };
}

export function parseGeminiResponse(json: unknown): ModelTurn {
  const body = json as {
    candidates?: { content?: { parts?: { text?: unknown; functionCall?: { name?: unknown; args?: unknown } }[] } }[];
    usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown };
  } | null;
  const parts = body?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) throw new AdapterError("Gemini did not return any output.", "invalid_output");

  const um = body?.usageMetadata;
  const usage =
    typeof um?.promptTokenCount === "number" && typeof um?.candidatesTokenCount === "number"
      ? { inputTokens: um.promptTokenCount, outputTokens: um.candidatesTokenCount }
      : undefined;

  const text = parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
  const toolCalls: ToolCall[] = [];
  parts.forEach((p) => {
    if (p?.functionCall && typeof p.functionCall.name === "string") {
      toolCalls.push({ id: `call_${toolCalls.length + 1}`, name: p.functionCall.name, arguments: p.functionCall.args ?? {} });
    }
  });
  if (toolCalls.length > 0) return { type: "toolCalls", toolCalls, ...(text ? { text } : {}), ...(usage ? { usage } : {}) };
  if (!text) throw new AdapterError("Gemini did not return any output.", "invalid_output");
  return { type: "text", text, ...(usage ? { usage } : {}) };
}
