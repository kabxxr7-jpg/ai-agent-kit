import { afterEach, describe, expect, it, vi } from "vitest";
import { AdapterError } from "../src/models/common";
import { buildGeminiRequest, createGeminiModel, parseGeminiResponse } from "../src/models/gemini";
import { buildOpenAIRequest, createOpenAIModel, parseOpenAIResponse } from "../src/models/openai";
import { formatToolResult } from "../src/format";
import type { Message, ToolSpec } from "../src/types";

afterEach(() => vi.unstubAllEnvs());

const KEY = "test-key-NOT-REAL-123";
const tools: ToolSpec[] = [{ name: "lookup_order", description: "Look up", inputSchema: { type: "object", properties: { orderId: { type: "string" } } } }];
const conversation: Message[] = [
  { role: "system", content: "SYS" },
  { role: "user", content: "where is ORD-1001" },
  { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "lookup_order", arguments: { orderId: "ORD-1001" } }] },
  formatToolResult({ id: "call_1", name: "lookup_order", arguments: {} }, "ok", { found: true }),
];

function fakeFetch(status: number, body: unknown, capture?: { url?: string; init?: RequestInit }) {
  return (async (url: string, init: RequestInit) => {
    if (capture) {
      capture.url = url;
      capture.init = init;
    }
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

describe("gemini adapter", () => {
  it("builds the request: system instruction, roles, function call and response, tool declarations", () => {
    const req = buildGeminiRequest(conversation, tools) as any;
    expect(req.systemInstruction).toEqual({ parts: [{ text: "SYS" }] });
    expect(req.contents.map((c: any) => c.role)).toEqual(["user", "model", "user"]);
    expect(req.contents[1].parts).toEqual([{ functionCall: { name: "lookup_order", args: { orderId: "ORD-1001" } } }]);
    const fr = req.contents[2].parts[0].functionResponse;
    expect(fr.name).toBe("lookup_order");
    // the untrusted wrapper survives the translation
    expect(fr.response.result).toContain('trust="untrusted"');
    expect(req.tools[0].functionDeclarations).toEqual([{ name: "lookup_order", description: "Look up", parametersJsonSchema: tools[0]!.inputSchema }]);
  });

  it("omits tools and system when there are none", () => {
    const req = buildGeminiRequest([{ role: "user", content: "hi" }], []) as any;
    expect(req.tools).toBeUndefined();
    expect(req.systemInstruction).toBeUndefined();
  });

  it("sends the key in a header, not the URL, and returns text with usage", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const model = createGeminiModel({
      apiKey: KEY,
      model: "m-1",
      fetch: fakeFetch(200, { candidates: [{ content: { parts: [{ text: "hello" }] } }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 3 } }, capture),
    });
    const turn = await model.generate([{ role: "user", content: "hi" }], []);
    expect(turn).toEqual({ type: "text", text: "hello", usage: { inputTokens: 11, outputTokens: 3 } });
    expect(capture.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/m-1:generateContent");
    expect(capture.url).not.toContain(KEY);
    expect((capture.init!.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
    expect(capture.init!.method).toBe("POST");
  });

  it("parses function calls into tool calls with generated ids", () => {
    const turn = parseGeminiResponse({
      candidates: [{ content: { parts: [{ functionCall: { name: "a", args: { x: 1 } } }, { functionCall: { name: "b" } }] } }],
    });
    expect(turn).toEqual({
      type: "toolCalls",
      toolCalls: [
        { id: "call_1", name: "a", arguments: { x: 1 } },
        { id: "call_2", name: "b", arguments: {} },
      ],
    });
  });

  it("throws not_configured without a key, and does not call fetch", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const f = vi.fn();
    const model = createGeminiModel({ fetch: f as never });
    await expect(model.generate([], [])).rejects.toMatchObject({ kind: "not_configured" });
    expect(f).not.toHaveBeenCalled();
  });

  it("reads the key from the environment at call time", async () => {
    vi.stubEnv("GEMINI_API_KEY", KEY);
    const capture: { url?: string; init?: RequestInit } = {};
    const model = createGeminiModel({ fetch: fakeFetch(200, { candidates: [{ content: { parts: [{ text: "ok" }] } }] }, capture) });
    await model.generate([{ role: "user", content: "hi" }], []);
    expect((capture.init!.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
  });

  it.each([
    [429, "rate_limit"],
    [500, "api_error"],
    [401, "api_error"],
  ])("maps HTTP %i to %s without leaking the key", async (status, kind) => {
    const model = createGeminiModel({ apiKey: KEY, fetch: fakeFetch(status, { error: { message: `bad key ${KEY}` } }) });
    const err = await model.generate([{ role: "user", content: "hi" }], []).catch((e) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect(err.kind).toBe(kind);
    expect(err.message).not.toContain(KEY);
  });

  it("maps network failures, bad JSON and empty output", async () => {
    const boom = (async () => {
      throw new TypeError(`fetch failed for ${KEY}`);
    }) as unknown as typeof fetch;
    const e1 = await createGeminiModel({ apiKey: KEY, fetch: boom }).generate([], []).catch((e) => e);
    expect(e1).toMatchObject({ kind: "api_error" });
    expect(e1.message).not.toContain(KEY);
    await expect(createGeminiModel({ apiKey: KEY, fetch: fakeFetch(200, "not json") }).generate([], [])).rejects.toMatchObject({ kind: "invalid_output" });
    await expect(createGeminiModel({ apiKey: KEY, fetch: fakeFetch(200, { candidates: [] }) }).generate([], [])).rejects.toMatchObject({ kind: "invalid_output" });
    await expect(createGeminiModel({ apiKey: KEY, fetch: fakeFetch(200, { candidates: [{ content: { parts: [{ text: "" }] } }] }) }).generate([], [])).rejects.toMatchObject({ kind: "invalid_output" });
  });

  it("passes an abort signal to fetch that fires when the run's signal fires", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const ac = new AbortController();
    const model = createGeminiModel({ apiKey: KEY, fetch: fakeFetch(200, { candidates: [{ content: { parts: [{ text: "ok" }] } }] }, capture) });
    await model.generate([{ role: "user", content: "hi" }], [], { signal: ac.signal });
    const signal = capture.init!.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    ac.abort();
    expect(signal.aborted).toBe(true);
  });
});

describe("openai adapter", () => {
  it("builds the request: roles, tool_calls with JSON-string arguments, tool messages, tool declarations", () => {
    const req = buildOpenAIRequest("m-1", conversation, tools) as any;
    expect(req.model).toBe("m-1");
    expect(req.messages.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(req.messages[2].tool_calls).toEqual([{ id: "call_1", type: "function", function: { name: "lookup_order", arguments: '{"orderId":"ORD-1001"}' } }]);
    expect(req.messages[2].content).toBeNull();
    expect(req.messages[3]).toMatchObject({ tool_call_id: "call_1" });
    expect(req.messages[3].content).toContain('trust="untrusted"');
    expect(req.tools).toEqual([{ type: "function", function: { name: "lookup_order", description: "Look up", parameters: tools[0]!.inputSchema } }]);
  });

  it("sends the key as a bearer token and returns text with usage", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const model = createOpenAIModel({
      apiKey: KEY,
      fetch: fakeFetch(200, { choices: [{ message: { content: "hello" } }], usage: { prompt_tokens: 9, completion_tokens: 2 } }, capture),
    });
    const turn = await model.generate([{ role: "user", content: "hi" }], []);
    expect(turn).toEqual({ type: "text", text: "hello", usage: { inputTokens: 9, outputTokens: 2 } });
    expect(capture.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(capture.url).not.toContain(KEY);
    expect((capture.init!.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });

  it("parses tool calls, decoding the JSON argument string", () => {
    const turn = parseOpenAIResponse({
      choices: [{ message: { content: null, tool_calls: [{ id: "abc", type: "function", function: { name: "lookup_order", arguments: '{"orderId":"ORD-1001"}' } }] } }],
    });
    expect(turn).toEqual({ type: "toolCalls", toolCalls: [{ id: "abc", name: "lookup_order", arguments: { orderId: "ORD-1001" } }] });
  });

  it("passes unparseable arguments on as a string so the tool schema rejects them", () => {
    const turn = parseOpenAIResponse({ choices: [{ message: { tool_calls: [{ id: "a", function: { name: "t", arguments: "{oops" } }] } }] });
    expect(turn).toMatchObject({ type: "toolCalls", toolCalls: [{ arguments: "{oops" }] });
  });

  it("throws not_configured without a key, and does not call fetch", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const f = vi.fn();
    await expect(createOpenAIModel({ fetch: f as never }).generate([], [])).rejects.toMatchObject({ kind: "not_configured" });
    expect(f).not.toHaveBeenCalled();
  });

  it.each([
    [429, "rate_limit"],
    [503, "api_error"],
  ])("maps HTTP %i to %s without leaking the key", async (status, kind) => {
    const err = await createOpenAIModel({ apiKey: KEY, fetch: fakeFetch(status, { error: KEY }) }).generate([{ role: "user", content: "x" }], []).catch((e) => e);
    expect(err.kind).toBe(kind);
    expect(err.message).not.toContain(KEY);
  });

  it("maps bad JSON and empty output", async () => {
    await expect(createOpenAIModel({ apiKey: KEY, fetch: fakeFetch(200, "<html>") }).generate([], [])).rejects.toMatchObject({ kind: "invalid_output" });
    await expect(createOpenAIModel({ apiKey: KEY, fetch: fakeFetch(200, { choices: [] }) }).generate([], [])).rejects.toMatchObject({ kind: "invalid_output" });
    await expect(createOpenAIModel({ apiKey: KEY, fetch: fakeFetch(200, { choices: [{ message: { content: "" } }] }) }).generate([], [])).rejects.toMatchObject({ kind: "invalid_output" });
  });
});
