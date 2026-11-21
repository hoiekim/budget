/**
 * A record of every request a test file made and every upstream call the
 * server made in answer, written per target. `conformance/compare.ts` reads
 * the Bun and Rust transcripts of the same file side by side: the test code is
 * identical, so any difference is a difference between the servers, including
 * ones no assertion looked at.
 */
import fs from "node:fs";
import path from "node:path";
import { TARGET, TRANSCRIPT_DIR } from "./config";

export interface HttpRecord {
  kind: "http";
  /** Position among this file's requests, in the order they were sent. */
  seq: number;
  /** Which started server of the file answered, in start order. */
  stack: number;
  method: string;
  path: string;
  requestBody?: unknown;
  status: number;
  headers: Record<string, string | string[]>;
  body: unknown;
}

export interface UpstreamRecord {
  kind: "upstream";
  stack: number;
  host: string;
  method: string;
  path: string;
  search: string;
  body: unknown;
}

export type TranscriptRecord = HttpRecord | UpstreamRecord;

const files = new Map<string, TranscriptRecord[]>();
const sequences = new Map<string, number>();

/** The test file a call came from, from the stack; transcripts are grouped by it. */
export const callerTestFile = (): string => {
  const stack = new Error().stack ?? "";
  const match = /\/conformance\/tests\/([^\s:)]+\.test\.ts)/.exec(stack);
  return match ? match[1] : "unknown";
};

export const nextSeq = (file: string): number => {
  const seq = sequences.get(file) ?? 0;
  sequences.set(file, seq + 1);
  return seq;
};

export const record = (file: string, entry: TranscriptRecord): void => {
  const list = files.get(file) ?? [];
  list.push(entry);
  files.set(file, list);
};

/** Writes what `file` recorded so far. Called as each of its servers stops. */
export const flush = (file: string): void => {
  const list = files.get(file);
  if (!list) return;
  const out = path.join(TRANSCRIPT_DIR, TARGET, `${file.replace(/\//g, "__")}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(list, null, 1));
};
