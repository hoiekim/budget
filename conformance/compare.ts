/**
 * Compares the transcripts two conformance runs left behind: every request a
 * test made and every upstream call the server made, Bun against Rust. The
 * test code is the same for both, so the exchanges line up one to one, and a
 * difference here is a difference between the servers even where no test
 * asserted on it.
 *
 *   bun conformance/compare.ts            # every file both targets ran
 *   bun conformance/compare.ts login      # only files whose name contains "login"
 *
 * Values that legitimately differ between two runs are masked first: ids the
 * server generates, timestamps, tokens, ports. Arrays of objects are compared
 * without regard to order, since rows keyed by random ids sort differently on
 * each run; tests assert order where it matters.
 */
import fs from "node:fs";
import path from "node:path";
import { TRANSCRIPT_DIR } from "./harness/config";
import type { HttpRecord, TranscriptRecord, UpstreamRecord } from "./harness/transcript";

const NOW = Date.now();
const DAY = 86_400_000;

const maskString = (text: string): string =>
  text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<timestamp>")
    .replace(/bk_[A-Za-z0-9_-]{43}/g, "<api-key>")
    .replace(/bk_[A-Za-z0-9_-]{8}(?![A-Za-z0-9_-])/g, "<api-key-prefix>")
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, "<jwt>")
    .replace(/[A-Za-z0-9_-]{40,}/g, "<token>")
    .replace(/(127\.0\.0\.1|localhost):\d{2,5}/g, "$1:<port>")
    .replace(/\b\d{13}\b/g, (digits) => (Math.abs(Number(digits) - NOW) < 3 * DAY ? "<epoch-ms>" : digits))
    .replace(/\b1\d{9}\b/g, (digits) => `<epoch-s:day ${Math.round(Number(digits) / 86_400)}>`);

const canonical = (value: unknown): unknown => {
  if (typeof value === "string") return maskString(value);
  if (typeof value === "number") return Math.abs(value - NOW) < 3 * DAY ? "<epoch-ms>" : value;
  if (Array.isArray(value)) {
    const items = value.map(canonical);
    const allObjects = items.length > 1 && items.every((item) => typeof item === "object" && item !== null);
    return allObjects ? [...items].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)) : items;
  }
  if (typeof value === "object" && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[maskString(key)] = canonical((value as Record<string, unknown>)[key]);
    return sorted;
  }
  return value;
};

const differences = (left: unknown, right: unknown, at: string, out: string[]): void => {
  if (out.length >= 12) return;
  if (JSON.stringify(left) === JSON.stringify(right)) return;
  const bothObjects =
    typeof left === "object" && left !== null && typeof right === "object" && right !== null &&
    Array.isArray(left) === Array.isArray(right);
  if (!bothObjects) {
    const show = (value: unknown) => {
      const text = value === undefined ? "(absent)" : JSON.stringify(value);
      return text.length > 300 ? `${text.slice(0, 300)}…` : text;
    };
    out.push(`    ${at || "(whole value)"}\n      bun:  ${show(left)}\n      rust: ${show(right)}`);
    return;
  }
  const keys = new Set([...Object.keys(left as object), ...Object.keys(right as object)]);
  for (const key of keys) {
    differences(
      (left as Record<string, unknown>)[key],
      (right as Record<string, unknown>)[key],
      Array.isArray(left) ? `${at}[${key}]` : at ? `${at}.${key}` : key,
      out,
    );
  }
};

const read = (target: string, file: string): TranscriptRecord[] =>
  JSON.parse(fs.readFileSync(path.join(TRANSCRIPT_DIR, target, file), "utf8"));

const httpOf = (records: TranscriptRecord[]): HttpRecord[] =>
  records.filter((r): r is HttpRecord => r.kind === "http").sort((a, b) => a.seq - b.seq);

/** Upstream calls grouped by started server and host, each group in arrival order. */
const upstreamOf = (records: TranscriptRecord[]): Map<string, UpstreamRecord[]> => {
  const groups = new Map<string, UpstreamRecord[]>();
  for (const record of records) {
    if (record.kind !== "upstream") continue;
    const key = `server ${record.stack} → ${record.host}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return groups;
};

export const compareTranscripts = (filter: string[] = []): { compared: number; problems: string[] } => {
  const list = (target: string) => {
    try {
      return fs.readdirSync(path.join(TRANSCRIPT_DIR, target)).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
  };
  const bunFiles = list("bun");
  const rustFiles = new Set(list("rust"));
  const problems: string[] = [];
  let compared = 0;

  for (const file of bunFiles.sort()) {
    if (filter.length > 0 && !filter.some((f) => file.includes(f))) continue;
    if (!rustFiles.has(file)) continue;
    compared++;
    const name = file.replace(/\.json$/, "").replace(/__/g, "/");
    const [bun, rust] = [read("bun", file), read("rust", file)];

    const [bunHttp, rustHttp] = [httpOf(bun), httpOf(rust)];
    if (bunHttp.length !== rustHttp.length) {
      problems.push(`${name}: bun answered ${bunHttp.length} requests, rust ${rustHttp.length}`);
    }
    for (let i = 0; i < Math.min(bunHttp.length, rustHttp.length); i++) {
      const [a, b] = [bunHttp[i], rustHttp[i]];
      const pick = (r: HttpRecord) => canonical({ request: `${r.method} ${r.path}`, status: r.status, headers: r.headers, body: r.body });
      const out: string[] = [];
      differences(pick(a), pick(b), "", out);
      if (out.length > 0) problems.push(`${name}: request #${a.seq} ${a.method} ${maskString(a.path)}\n${out.join("\n")}`);
    }

    const [bunUp, rustUp] = [upstreamOf(bun), upstreamOf(rust)];
    for (const key of new Set([...bunUp.keys(), ...rustUp.keys()])) {
      const pick = (records: UpstreamRecord[] | undefined) =>
        (records ?? []).map((r) => JSON.stringify(canonical({ call: `${r.method} ${r.path}`, search: r.search, body: r.body })));
      const [a, b] = [pick(bunUp.get(key)), pick(rustUp.get(key))];
      if (a.length !== b.length) problems.push(`${name}: ${key}: bun made ${a.length} calls, rust ${b.length}`);
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a[i] === b[i]) continue;
        const out: string[] = [];
        differences(JSON.parse(a[i]), JSON.parse(b[i]), "", out);
        problems.push(`${name}: ${key}: call #${i + 1}\n${out.join("\n")}`);
      }
    }
  }
  return { compared, problems };
};

if (import.meta.main) {
  const { compared, problems } = compareTranscripts(process.argv.slice(2));
  if (compared === 0) {
    console.error("No transcripts to compare: run the suite against both targets first.");
    process.exit(2);
  }
  if (problems.length > 0) {
    console.error(`The servers answered differently in ${problems.length} place(s):\n`);
    for (const problem of problems) console.error(`  ${problem}\n`);
    process.exit(1);
  }
  console.log(`Bun and Rust transcripts match across ${compared} test file(s).`);
}
