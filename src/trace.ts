import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TraceEvent } from "./types";

/** Appends one JSON line per trace event. `reset` starts the file empty. */
export function createJsonlTrace(path: string, options: { reset?: boolean } = {}): (event: TraceEvent) => void {
  mkdirSync(dirname(path), { recursive: true });
  if (options.reset) writeFileSync(path, "");
  return (event) => appendFileSync(path, JSON.stringify(event) + "\n");
}

export function readJsonlTrace(path: string): TraceEvent[] {
  const text = readFileSync(path, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as TraceEvent);
}
