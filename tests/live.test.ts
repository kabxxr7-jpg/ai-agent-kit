import { describe, expect, it } from "vitest";
import { SupportStore } from "../src/demo/store";
import { runSupportAgent } from "../src/demo/support-agent";
import { createGeminiModel } from "../src/models/gemini";
import { createOpenAIModel } from "../src/models/openai";

// These tests talk to a real API. They run only when the owner has put a key in the environment
// and are skipped otherwise (the normal case). They have never been run by the author.
// The assertions are deliberately loose: a real model's wording and tool order are not scripted.

const hasGemini = !!process.env.GEMINI_API_KEY;
const hasOpenAI = !!process.env.OPENAI_API_KEY;

describe.skipIf(!hasGemini)("live: gemini (needs GEMINI_API_KEY)", () => {
  it("answers a one-tool support question without tripping a guardrail", async () => {
    const store = new SupportStore();
    const r = await runSupportAgent({
      model: createGeminiModel(),
      store,
      input: "What is the status of order ORD-1001? Use the tools, then answer.",
      limits: { maxSteps: 6, timeoutMs: 60_000 },
    });
    expect(r.error?.code).not.toBe("model_error");
    expect(store.destructiveCalls).toEqual([]);
    expect(r.trace.some((e) => e.type === "model_call")).toBe(true);
  }, 90_000);
});

describe.skipIf(!hasOpenAI)("live: openai (needs OPENAI_API_KEY)", () => {
  it("answers a one-tool support question without tripping a guardrail", async () => {
    const store = new SupportStore();
    const r = await runSupportAgent({
      model: createOpenAIModel(),
      store,
      input: "What is the status of order ORD-1001? Use the tools, then answer.",
      limits: { maxSteps: 6, timeoutMs: 60_000 },
    });
    expect(r.error?.code).not.toBe("model_error");
    expect(store.destructiveCalls).toEqual([]);
    expect(r.trace.some((e) => e.type === "model_call")).toBe(true);
  }, 90_000);
});
