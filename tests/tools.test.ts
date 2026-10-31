import { describe, expect, it } from "vitest";
import { defineTool, ToolRegistry } from "../src/tools";
import { makeRegistry } from "./helpers";

describe("defineTool / ToolRegistry registration", () => {
  const base = {
    description: "d",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    execute: () => ({}),
  };

  it("rejects bad names and unsupported schemas", () => {
    expect(() => defineTool({ ...base, name: "has space" })).toThrow("invalid tool name");
    expect(() => defineTool({ ...base, name: "ok", inputSchema: { type: "object", format: "x" } })).toThrow("unsupported schema keyword");
    expect(() => defineTool({ ...base, name: "ok", outputSchema: { anyOf: [] } })).toThrow("outputSchema");
  });

  it("rejects duplicates", () => {
    const r = new ToolRegistry([defineTool({ ...base, name: "a" })]);
    expect(() => r.register(defineTool({ ...base, name: "a" }))).toThrow("already registered");
  });

  it("re-checks tools that were not built with defineTool", () => {
    expect(() => new ToolRegistry([{ ...base, name: "x y" }])).toThrow("invalid tool name");
  });

  it("specs() lists only the requested names and hides the output schema and execute", () => {
    const { registry } = makeRegistry();
    const specs = registry.specs(["echo", "nope"]);
    expect(specs.map((s) => s.name)).toEqual(["echo"]);
    expect(Object.keys(specs[0]!).sort()).toEqual(["description", "inputSchema", "name"]);
  });
});

describe("ToolRegistry.execute", () => {
  it("runs a valid call and returns the validated output", async () => {
    const { registry, executed } = makeRegistry();
    expect(await registry.execute("echo", { message: "hi" })).toEqual({ ok: true, output: { echoed: "hi" } });
    expect(executed).toHaveLength(1);
  });

  it("rejects invalid input without running the tool", async () => {
    const { registry, executed } = makeRegistry();
    const r = await registry.execute("echo", { message: 5 });
    expect(r).toMatchObject({ ok: false, error: { code: "invalid_arguments", details: ["$.message: expected string, got number"] } });
    expect((await registry.execute("echo", {})).ok).toBe(false);
    expect((await registry.execute("echo", { message: "x", extra: 1 })).ok).toBe(false);
    expect(executed).toHaveLength(0);
  });

  it("returns a structured error when the tool throws, never throws itself", async () => {
    const { registry } = makeRegistry();
    const r = await registry.execute("boom", {});
    expect(r).toEqual({ ok: false, error: { code: "tool_error", message: "kaboom: disk on fire" } });
  });

  it("truncates very long tool error messages", async () => {
    const registry = new ToolRegistry([
      defineTool({
        name: "long",
        description: "d",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        execute: () => {
          throw new Error("x".repeat(5000));
        },
      }),
    ]);
    const r = await registry.execute("long", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message.length).toBe(300);
  });

  it("validates output and reports invalid_output", async () => {
    const { registry } = makeRegistry();
    const r = await registry.execute("bad_output", {});
    expect(r).toMatchObject({ ok: false, error: { code: "invalid_output", details: ["$.n: expected integer, got string"] } });
  });

  it("reports unknown tools", async () => {
    const { registry } = makeRegistry();
    expect(await registry.execute("nope", {})).toMatchObject({ ok: false, error: { code: "unknown_tool" } });
  });
});
