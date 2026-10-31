import { assertSchema, validate } from "./schema";
import type { JsonSchema, ToolSpec } from "./types";

export interface ToolContext {
  signal?: AbortSignal;
}

export interface Tool<I = any, O = any> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  execute(input: I, ctx: ToolContext): Promise<O> | O;
}

export type ToolErrorCode = "unknown_tool" | "invalid_arguments" | "tool_error" | "invalid_output";

export type ToolOutcome =
  | { ok: true; output: unknown }
  | { ok: false; error: { code: ToolErrorCode; message: string; details?: string[] } };

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const MAX_ERROR_CHARS = 300;

export function defineTool<I, O>(tool: Tool<I, O>): Tool<I, O> {
  if (!NAME_RE.test(tool.name)) throw new Error(`invalid tool name "${tool.name}"`);
  assertSchema(tool.inputSchema, `${tool.name}.inputSchema`);
  assertSchema(tool.outputSchema, `${tool.name}.outputSchema`);
  return tool;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: Tool[] = []) {
    for (const t of tools) this.register(t);
  }

  register(tool: Tool): this {
    defineTool(tool); // re-checks name and schemas for tools built by hand
    if (this.tools.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`);
    this.tools.set(tool.name, tool);
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** What the model is shown. Only the names passed in, in registry order. */
  specs(names: Iterable<string>): ToolSpec[] {
    const wanted = new Set(names);
    return [...this.tools.values()]
      .filter((t) => wanted.has(t.name))
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  }

  /**
   * Validates the arguments, runs the tool, validates what it returned. Never throws: every
   * failure comes back as a structured error the agent can show to the model.
   */
  async execute(name: string, args: unknown, ctx: ToolContext = {}): Promise<ToolOutcome> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: { code: "unknown_tool", message: `no tool named "${name}"` } };

    const inputErrors = validate(tool.inputSchema, args);
    if (inputErrors.length > 0) {
      return {
        ok: false,
        error: { code: "invalid_arguments", message: `arguments for "${name}" do not match its input schema`, details: inputErrors },
      };
    }

    let output: unknown;
    try {
      output = await tool.execute(args, ctx);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      return { ok: false, error: { code: "tool_error", message: text.slice(0, MAX_ERROR_CHARS) } };
    }

    const outputErrors = validate(tool.outputSchema, output);
    if (outputErrors.length > 0) {
      return {
        ok: false,
        error: { code: "invalid_output", message: `"${name}" returned data that does not match its output schema`, details: outputErrors },
      };
    }
    return { ok: true, output };
  }
}
