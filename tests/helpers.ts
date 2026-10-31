import { defineTool, ToolRegistry } from "../src/tools";
import type { ModelTurn, ToolCall } from "../src/types";

export const call = (name: string, args: unknown = {}, id = `c_${name}`): ToolCall => ({ id, name, arguments: args });
export const calls = (...c: ToolCall[]): ModelTurn => ({ type: "toolCalls", toolCalls: c });
export const say = (text: unknown, usage?: { inputTokens: number; outputTokens: number }): ModelTurn => ({
  type: "text",
  text: typeof text === "string" ? text : JSON.stringify(text),
  ...(usage ? { usage } : {}),
});

/** A tiny registry with an `echo` tool, a `boom` tool that throws and a `bad_output` tool, plus a spy. */
export function makeRegistry() {
  const executed: { name: string; input: unknown }[] = [];
  const registry = new ToolRegistry([
    defineTool({
      name: "echo",
      description: "Echo a message",
      inputSchema: { type: "object", properties: { message: { type: "string", minLength: 1 } }, required: ["message"], additionalProperties: false },
      outputSchema: { type: "object", properties: { echoed: { type: "string" } }, required: ["echoed"] },
      execute: (input: { message: string }) => {
        executed.push({ name: "echo", input });
        return { echoed: input.message };
      },
    }),
    defineTool({
      name: "boom",
      description: "Always throws",
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
      execute: () => {
        executed.push({ name: "boom", input: {} });
        throw new Error("kaboom: disk on fire");
      },
    }),
    defineTool({
      name: "bad_output",
      description: "Returns the wrong shape",
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
      execute: () => {
        executed.push({ name: "bad_output", input: {} });
        return { n: "not a number" };
      },
    }),
    defineTool({
      name: "danger",
      description: "Must never run in tests that do not allow it",
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
      execute: () => {
        executed.push({ name: "danger", input: {} });
        return { done: true };
      },
    }),
    defineTool({
      name: "free",
      description: "Accepts any object",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      execute: (input: unknown) => {
        executed.push({ name: "free", input });
        return {};
      },
    }),
    defineTool({
      name: "slow",
      description: "Takes a while",
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
      execute: async (_input: unknown, ctx) => {
        executed.push({ name: "slow", input: {} });
        await new Promise((r) => setTimeout(r, 400));
        void ctx;
        return {};
      },
    }),
  ]);
  return { registry, executed };
}
