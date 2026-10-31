import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, USAGE, type Io } from "../src/cli";
import { readJsonlTrace } from "../src/trace";

const ROOT = resolve(__dirname, "..");
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "agent-kit-cli-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeIo(env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { log: (l) => out.push(l), error: (l) => err.push(l), env };
  return { io, out, err, text: () => out.join("\n"), errText: () => err.join("\n") };
}

// Run from the project root so the default scenario path resolves.
const inRoot = async <T>(fn: () => Promise<T>): Promise<T> => {
  const prev = process.cwd();
  process.chdir(ROOT);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
};

describe("eval command", () => {
  it("runs the default scenarios with the mock model, prints PASS lines and a summary, exits 0", async () => {
    const c = makeIo();
    const code = await inRoot(() => runCli(["eval"], c.io));
    expect(code).toBe(0);
    expect(c.out.filter((l) => l.startsWith("PASS")).length).toBeGreaterThanOrEqual(12);
    expect(c.text()).not.toContain("FAIL");
    expect(c.out.at(-1)).toMatch(/^Summary: \d+ passed, 0 failed, \d+ scenarios \(model: mock \(scripted\)\)$/);
  });

  it("exits 1 and prints the failing reason when a scenario fails", async () => {
    const dir = tmp();
    const file = join(dir, "s.json");
    writeFileSync(
      file,
      JSON.stringify({
        scenarios: [
          { id: "will-fail", input: "x", mockTurns: [{ text: { resolution: "info_provided", summary: "ok" } }], expect: { stopReason: "maxSteps" } },
          { id: "will-pass", input: "x", mockTurns: [{ text: { resolution: "info_provided", summary: "ok" } }], expect: {} },
        ],
      }),
    );
    const c = makeIo();
    const code = await runCli(["eval", "--scenarios", file], c.io);
    expect(code).toBe(1);
    expect(c.text()).toContain("FAIL  will-fail");
    expect(c.text()).toContain("stopReason: expected maxSteps, got done");
    expect(c.text()).toContain("PASS  will-pass");
    expect(c.out.at(-1)).toContain("1 passed, 1 failed, 2 scenarios");
  });

  it("writes the trace file and the JSON results when asked", async () => {
    const dir = tmp();
    const c = makeIo();
    const code = await inRoot(() => runCli(["eval", "--only", "refund-eligible", "--trace", join(dir, "t.jsonl"), "--json", join(dir, "r.json")], c.io));
    expect(code).toBe(0);
    expect(readJsonlTrace(join(dir, "t.jsonl")).length).toBeGreaterThan(3);
    const json = JSON.parse(readFileSync(join(dir, "r.json"), "utf8"));
    expect(json.results).toHaveLength(1);
    expect(json.results[0]).toMatchObject({ id: "refund-eligible", passed: true });
  });

  it("overwrites the trace file on each run", async () => {
    const dir = tmp();
    const path = join(dir, "t.jsonl");
    await inRoot(() => runCli(["eval", "--only", "refund-eligible", "--trace", path], makeIo().io));
    const first = readJsonlTrace(path).length;
    await inRoot(() => runCli(["eval", "--only", "refund-eligible", "--trace", path], makeIo().io));
    expect(readJsonlTrace(path)).toHaveLength(first);
  });

  it("rejects an unknown scenario id, a missing file, bad options and a bad model name", async () => {
    let c = makeIo();
    expect(await inRoot(() => runCli(["eval", "--only", "nope"], c.io))).toBe(2);
    expect(c.errText()).toContain('no scenario with id "nope"');
    c = makeIo();
    expect(await runCli(["eval", "--scenarios", "/does/not/exist.json"], c.io)).toBe(2);
    expect(c.errText()).toContain("cannot load scenarios");
    c = makeIo();
    expect(await runCli(["eval", "--bogus"], c.io)).toBe(2);
    c = makeIo();
    expect(await runCli(["eval", "--model", "llama"], c.io)).toBe(2);
    expect(c.errText()).toContain("--model must be mock, gemini or openai");
  });

  it("prints usage for no command or --help", async () => {
    const c = makeIo();
    expect(await runCli([], c.io)).toBe(0);
    expect(c.errText()).toBe(USAGE);
    const h = makeIo();
    expect(await runCli(["eval", "--help"], h.io)).toBe(0);
    expect(h.text()).toContain("Usage:");
    expect(await runCli(["bogus"], makeIo().io)).toBe(2);
  });
});

describe("real models without a key", () => {
  it.each([
    ["gemini", "GEMINI_API_KEY"],
    ["openai", "OPENAI_API_KEY"],
  ])("--model %s is skipped cleanly with exit 0 when %s is not set", async (model, variable) => {
    const c = makeIo({});
    const code = await inRoot(() => runCli(["eval", "--model", model], c.io));
    expect(code).toBe(0);
    expect(c.text()).toBe(`SKIPPED: --model ${model} needs ${variable} in the environment. Nothing was run and nothing was sent.`);
    // same for the demo
    const d = makeIo({});
    expect(await runCli(["demo", "--model", model], d.io)).toBe(0);
    expect(d.text()).toContain("SKIPPED");
  });

  it("an empty key counts as not set", async () => {
    const c = makeIo({ GEMINI_API_KEY: "" });
    expect(await runCli(["eval", "--model", "gemini"], c.io)).toBe(0);
    expect(c.text()).toContain("SKIPPED");
  });

  it("never prints the key when it is set (run against a refused connection)", async () => {
    const key = "test-key-NOT-REAL-should-never-print";
    const c = makeIo({ OPENAI_API_KEY: key });
    // A key is present, so the CLI proceeds to call the adapter. Point the process at an unusable
    // fetch so no network call is made, and check the output.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError(`connect refused for ${key}`);
    }) as typeof fetch;
    const prevEnv = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = key;
    try {
      await inRoot(() => runCli(["eval", "--model", "openai", "--only", "refund-eligible"], c.io));
    } finally {
      globalThis.fetch = realFetch;
      if (prevEnv === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevEnv;
    }
    expect(c.text()).not.toContain(key);
    expect(c.errText()).not.toContain(key);
    expect(c.text()).toContain("FAIL");
  });
});

describe("demo command", () => {
  it("runs the support agent end to end with the scripted model", async () => {
    const c = makeIo();
    const code = await runCli(["demo"], c.io);
    expect(code).toBe(0);
    expect(c.text()).toContain("Customer: Hi, I got order ORD-1001");
    expect(c.text()).toContain('tool lookup_order({"orderId":"ORD-1001"}) -> ok');
    expect(c.text()).toContain('tool check_refund_eligibility({"orderId":"ORD-1001"}) -> ok');
    expect(c.text()).toContain("Stop reason: done");
    expect(c.text()).toContain('"resolution":"refund_eligible"');
  });
});
