import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { formatResult, formatSummary, loadScenarios, runScenarios } from "./eval";
import { SupportStore } from "./demo/store";
import { runSupportAgent } from "./demo/support-agent";
import { createGeminiModel } from "./models/gemini";
import { createMockModel, turnsFromSpecs } from "./models/mock";
import { createOpenAIModel } from "./models/openai";
import { createJsonlTrace } from "./trace";
import type { ModelAdapter } from "./types";

export interface Io {
  log(line: string): void;
  error(line: string): void;
  env: Record<string, string | undefined>;
}

const DEFAULT_SCENARIOS = "examples/scenarios.json";

export const USAGE = [
  "Usage:",
  "  npm run eval -- [--scenarios <file>] [--model mock|gemini|openai] [--trace <file.jsonl>] [--only <id>] [--json <file>]",
  "  npm run demo -- [--model mock|gemini|openai] [--trace <file.jsonl>]",
  "",
  `  --scenarios <file>   scenario JSON (default ${DEFAULT_SCENARIOS})`,
  "  --model <name>       mock (default, scripted, offline) | gemini (needs GEMINI_API_KEY) | openai (needs OPENAI_API_KEY)",
  "  --trace <file>       write one JSON line per step, with timings (overwritten each run)",
  "  --only <id>          run a single scenario",
  "  --json <file>        also write the results as JSON",
  "",
  "A real model without its key in the environment is skipped with a message and exit code 0.",
].join("\n");

const KEY_VAR = { gemini: "GEMINI_API_KEY", openai: "OPENAI_API_KEY" } as const;

type ModelChoice = "mock" | "gemini" | "openai";

function realModel(choice: "gemini" | "openai"): ModelAdapter {
  return choice === "gemini" ? createGeminiModel() : createOpenAIModel();
}

export async function runCli(argv: string[], io: Io = { log: console.log, error: console.error, env: process.env }): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== "eval" && command !== "demo") {
    io.error(USAGE);
    return command === undefined || command === "--help" || command === "-h" ? 0 : 2;
  }

  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        scenarios: { type: "string" },
        model: { type: "string", default: "mock" },
        trace: { type: "string" },
        only: { type: "string" },
        json: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    }));
  } catch (err) {
    io.error(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    io.log(USAGE);
    return 0;
  }
  const choice = values.model as string;
  if (choice !== "mock" && choice !== "gemini" && choice !== "openai") {
    io.error(`--model must be mock, gemini or openai (got "${choice}")`);
    return 2;
  }
  if (choice !== "mock" && !io.env[KEY_VAR[choice]]) {
    io.log(`SKIPPED: --model ${choice} needs ${KEY_VAR[choice]} in the environment. Nothing was run and nothing was sent.`);
    return 0;
  }
  const trace = values.trace ? createJsonlTrace(resolve(values.trace), { reset: true }) : undefined;

  if (command === "demo") return runDemo(choice as ModelChoice, trace, io);

  let scenarios;
  try {
    scenarios = loadScenarios(resolve(values.scenarios ?? DEFAULT_SCENARIOS));
  } catch (err) {
    io.error(`cannot load scenarios: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  if (values.only) {
    scenarios = scenarios.filter((s) => s.id === values.only);
    if (scenarios.length === 0) {
      io.error(`no scenario with id "${values.only}"`);
      return 2;
    }
  }

  const modelName = choice === "mock" ? "mock (scripted)" : realModel(choice).name;
  const results = await runScenarios(scenarios, {
    makeModel: choice === "mock" ? undefined : () => realModel(choice),
    onTrace: trace,
    onResult: (r) => io.log(formatResult(r)),
  });
  io.log(formatSummary(results, modelName));
  if (values.json) writeFileSync(resolve(values.json), JSON.stringify({ model: modelName, results }, null, 2) + "\n");
  if (trace && values.trace) io.log(`Trace written to ${values.trace}`);
  return results.every((r) => r.passed) ? 0 : 1;
}

const DEMO_INPUT = "Hi, I got order ORD-1001 last week and the mug handle is cracked. Can I get a refund?";

const DEMO_TURNS = [
  { toolCalls: [{ name: "lookup_order", arguments: { orderId: "ORD-1001" } }] },
  { toolCalls: [{ name: "check_refund_eligibility", arguments: { orderId: "ORD-1001" } }] },
  { text: { resolution: "refund_eligible", orderId: "ORD-1001", summary: "ORD-1001 was delivered on 2026-06-05, inside the 30-day window. Up to 49.90 can be refunded." } },
];

async function runDemo(choice: ModelChoice, trace: ((e: import("./types").TraceEvent) => void) | undefined, io: Io): Promise<number> {
  const model = choice === "mock" ? createMockModel(turnsFromSpecs(DEMO_TURNS).script) : realModel(choice);
  io.log(`Customer: ${DEMO_INPUT}`);
  const run = await runSupportAgent({ model, input: DEMO_INPUT, store: new SupportStore(), onTrace: trace, runId: "demo" });
  for (const c of run.toolCalls) io.log(`  tool ${c.name}(${JSON.stringify(c.arguments)}) -> ${c.status}`);
  io.log(`Stop reason: ${run.stopReason}${run.error ? ` (${run.error.code}: ${run.error.message})` : ""}`);
  io.log(`Final answer: ${JSON.stringify(run.finalAnswer)}`);
  io.log(`Steps: ${run.steps}, tokens: ${run.usage.totalTokens} (${choice === "mock" ? "estimated from text length" : "as reported by the API"}), ${Math.round(run.durationMs)} ms`);
  return run.stopReason === "done" ? 0 : 1;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  process.exitCode = await runCli(process.argv.slice(2));
}
