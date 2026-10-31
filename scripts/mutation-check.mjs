#!/usr/bin/env node
// Mutation check: break the source in ~20 deliberate ways, run the whole test suite against each
// broken copy, and report which breakages the tests noticed ("killed") and which they did not
// ("survived"). It works on a copy under .mutation-tmp/, so src/ is never modified.
//
//   node scripts/mutation-check.mjs            run everything
//   node scripts/mutation-check.mjs --list     list the mutants
//   node scripts/mutation-check.mjs --only id  run one mutant
//
// Exit code 0 when every mutant was killed, 1 when something survived, 2 when the setup is broken
// (for example the unmutated copy does not pass, or a mutant's search text no longer matches).

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = join(root, ".mutation-tmp");
const vitestBin = join(root, "node_modules", "vitest", "vitest.mjs");
const TIMEOUT_MS = 60_000;

/** Each mutant replaces `find` (which must occur exactly once in `file`) with `replace`. */
const mutants = [
  { id: "no-max-steps", what: "remove the max-steps check", file: "src/agent.ts", find: 'if (steps >= limits.maxSteps) return finish("maxSteps");', replace: "" },
  { id: "no-token-budget", what: "never stop on the token budget", file: "src/agent.ts", find: "if (inputTokens + outputTokens > limits.maxTotalTokens) {", replace: "if (false) {" },
  { id: "token-budget-off-by-one", what: "token budget: > becomes >=", file: "src/agent.ts", find: "inputTokens + outputTokens > limits.maxTotalTokens", replace: "inputTokens + outputTokens >= limits.maxTotalTokens" },
  { id: "no-cost-budget", what: "never stop on the cost budget", file: "src/agent.ts", find: "limits.maxCostUsd !== undefined && costUsd > limits.maxCostUsd", replace: "false" },
  { id: "no-timeout-race", what: "model and tool calls are no longer raced against the deadline", file: "src/agent.ts", find: "Promise.race([p, deadline])", replace: "p" },
  { id: "no-timeout-clock-check", what: "remove the wall-clock check at the top of each step", file: "src/agent.ts", find: 'if (timedOut()) return finish("timeout");', replace: "" },
  { id: "no-allow-list", what: "disable the tool allow-list", file: "src/agent.ts", find: "if (!allowed.has(call.name)) {", replace: "if (false) {" },
  { id: "no-loop-breaker", what: "disable repeated-call detection", file: "src/agent.ts", find: "if (seen >= limits.maxIdenticalCalls) {", replace: "if (false) {" },
  { id: "loop-breaker-never-counts", what: "repeated calls are never counted", file: "src/agent.ts", find: "callCounts.set(signature, seen + 1);", replace: "callCounts.set(signature, 0);" },
  { id: "key-order-matters", what: "loop breaker no longer ignores key order", file: "src/format.ts", find: ".sort()", replace: "" },
  { id: "no-final-answer-check", what: "accept any final text, skipping the answer schema", file: "src/agent.ts", find: "if (!finalAnswerSchema) return finish(", replace: "if (true) return finish(" },
  { id: "final-answer-unlimited-retries", what: "a rejected final answer can be retried forever", file: "src/agent.ts", find: "if (finalAnswerRetries >= 1) {", replace: "if (false) {" },
  { id: "bad-args-never-abort", what: "invalid arguments never abort the run", file: "src/agent.ts", find: "if (badCallStreak >= 2) return fail(", replace: "if (false) return fail(" },
  { id: "strikes-never-reset", what: "a successful call no longer resets the strike count", file: "src/agent.ts", find: "      badCallStreak = 0;\n", replace: "" },
  { id: "no-input-validation", what: "skip tool input validation", file: "src/tools.ts", find: "if (inputErrors.length > 0) {", replace: "if (false) {" },
  { id: "no-output-validation", what: "skip tool output validation", file: "src/tools.ts", find: "if (outputErrors.length > 0) {", replace: "if (false) {" },
  { id: "tool-errors-escape", what: "a throwing tool is no longer caught", file: "src/tools.ts", find: 'return { ok: false, error: { code: "tool_error", message: text.slice(0, MAX_ERROR_CHARS) } };', replace: "throw err;" },
  { id: "tool-output-trusted", what: "tool messages are no longer marked untrusted", file: "src/format.ts", find: "    untrusted: true,", replace: "    untrusted: false," },
  { id: "no-escape-in-wrapper", what: "tool output can close its own wrapper tag", file: "src/format.ts", find: 'return json.replace(/</g, "\\\\u003c");', replace: "return json;" },
  { id: "required-not-checked", what: "schema validator ignores required", file: "src/schema.ts", find: "if (!(key in obj) || obj[key] === undefined) errors.push(", replace: "if (false) errors.push(" },
  { id: "memory-no-window", what: "memory never trims to the window", file: "src/memory.ts", find: "let cut = Math.max(0, this.all.length - this.windowSize);", replace: "let cut = 0;" },
  { id: "memory-orphan-tool", what: "window may start on an orphaned tool result", file: "src/memory.ts", find: 'while (cut < this.all.length && this.all[cut]!.role === "tool") cut++;', replace: "" },
  { id: "summary-trusted", what: "summary message is no longer marked untrusted", file: "src/memory.ts", find: "    untrusted: true,", replace: "    untrusted: false," },
  { id: "gemini-key-in-url", what: "Gemini key is put in the URL", file: "src/models/gemini.ts", find: ":generateContent`, {", replace: ":generateContent?key=${apiKey}`, {" },
  { id: "eval-subset-any", what: "partial match passes when any key matches", file: "src/eval.ts", find: "return Object.entries(expected).every(", replace: "return Object.entries(expected).some(" },
];

function childEnv() {
  const env = { ...process.env };
  // Never let the live-API tests run during a mutation check.
  delete env.GEMINI_API_KEY;
  delete env.OPENAI_API_KEY;
  return env;
}

function makeCopy(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const name of ["src", "tests", "examples"]) cpSync(join(root, name), join(dir, name), { recursive: true });
  for (const name of ["package.json", "tsconfig.json", "vitest.config.ts"]) cpSync(join(root, name), join(dir, name));
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir");
}

function runTests(dir) {
  const r = spawnSync(process.execPath, [vitestBin, "run", "--reporter=json"], {
    cwd: dir,
    env: childEnv(),
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error && r.error.code === "ETIMEDOUT") return { status: "timeout", failed: [], total: 0 };
  const out = r.stdout ?? "";
  const start = out.indexOf("{");
  let json;
  try {
    json = JSON.parse(out.slice(start));
  } catch {
    return { status: "crash", failed: [], total: 0, detail: (r.stderr || out).slice(0, 400) };
  }
  const failed = [];
  for (const file of json.testResults ?? []) {
    if (file.status === "failed" && (file.assertionResults ?? []).every((a) => a.status !== "failed")) failed.push(`${file.name.split("/").pop()} (suite failed to run)`);
    for (const a of file.assertionResults ?? []) if (a.status === "failed") failed.push(a.fullName);
  }
  return {
    status: json.success ? "pass" : "fail",
    failed,
    total: json.numTotalTests ?? 0,
    passed: json.numPassedTests ?? 0,
    skipped: json.numPendingTests ?? 0,
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    for (const m of mutants) console.log(`${m.id.padEnd(34)} ${m.file.padEnd(22)} ${m.what}`);
    return 0;
  }
  const onlyIdx = args.indexOf("--only");
  const only = onlyIdx >= 0 ? args[onlyIdx + 1] : undefined;
  const selected = only ? mutants.filter((m) => m.id === only) : mutants;
  if (selected.length === 0) {
    console.error(`no mutant with id "${only}"`);
    return 2;
  }
  if (!existsSync(vitestBin)) {
    console.error("vitest is not installed; run npm install first");
    return 2;
  }

  // 1. every mutant must apply to exactly one place, otherwise it would silently test nothing
  for (const m of selected) {
    const text = readFileSync(join(root, m.file), "utf8");
    const count = text.split(m.find).length - 1;
    if (count !== 1) {
      console.error(`mutant ${m.id}: expected its search text exactly once in ${m.file}, found ${count}`);
      return 2;
    }
  }

  try {
    // 2. the unmutated copy must pass, otherwise "killed" would mean nothing
    const base = join(work, "baseline");
    makeCopy(base);
    const baseline = runTests(base);
    if (baseline.status !== "pass") {
      console.error(`baseline run did not pass (${baseline.status}). Fix the tests before running the mutation check.`);
      if (baseline.failed.length) console.error(baseline.failed.slice(0, 5).join("\n"));
      if (baseline.detail) console.error(baseline.detail);
      return 2;
    }
    console.log(`Baseline: ${baseline.passed} tests passed, ${baseline.skipped} skipped, on an unmodified copy.\n`);

    // 3. run each mutant
    const rows = [];
    for (const m of selected) {
      const dir = join(work, m.id);
      makeCopy(dir);
      const target = join(dir, m.file);
      writeFileSync(target, readFileSync(target, "utf8").replace(m.find, () => m.replace));
      const t0 = Date.now();
      const res = runTests(dir);
      const ms = Date.now() - t0;
      const killed = res.status === "fail" || res.status === "timeout";
      if (res.status === "crash") {
        console.error(`mutant ${m.id}: the test run crashed instead of reporting results:\n${res.detail}`);
        return 2;
      }
      rows.push({ m, killed, res, ms });
      const by = killed ? (res.status === "timeout" ? "timed out" : `${res.failed.length} failing test(s), e.g. ${res.failed[0]}`) : "NO TEST FAILED";
      console.log(`${killed ? "killed  " : "SURVIVED"}  ${m.id.padEnd(32)} ${m.what}\n          ${by}  [${ms} ms]`);
      rmSync(dir, { recursive: true, force: true });
    }

    const killedCount = rows.filter((r) => r.killed).length;
    console.log(`\nMutation result: ${killedCount} of ${rows.length} mutants killed (${Math.round((100 * killedCount) / rows.length)}%).`);
    const survivors = rows.filter((r) => !r.killed);
    if (survivors.length) {
      console.log("Survivors (the tests do not notice these breakages):");
      for (const s of survivors) console.log(`  - ${s.m.id}: ${s.m.what} (${s.m.file})`);
    }
    return survivors.length === 0 ? 0 : 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

process.exitCode = main();
