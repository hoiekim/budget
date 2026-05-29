import { readFile } from "node:fs/promises";

export interface TestCaseResult {
  classname: string;
  name: string;
  time: number;
  status: "pass" | "fail" | "skip";
  failure?: string;
}

export interface FileResult {
  /** Repo-root-relative POSIX path. */
  relPath: string;
  exitCode: number;
  durationMs: number;
  cases: TestCaseResult[];
  /** Bun stdout/stderr — only surfaced for failed files. */
  output?: string;
}

const decodeXmlEntities = (s: string): string =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/**
 * Minimal JUnit XML parser. Targeted at bun's `--reporter=junit` output, NOT
 * a general-purpose XML parser. Pulls `<testcase>` elements and their nested
 * `<failure>` / `<skipped>` markers.
 */
export const parseJUnitXml = async (path: string): Promise<TestCaseResult[]> => {
  let xml: string;
  try {
    xml = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const cases: TestCaseResult[] = [];
  const testcaseRe =
    /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  let m: RegExpExecArray | null;
  while ((m = testcaseRe.exec(xml)) !== null) {
    const attrs = m[1];
    const body = m[2] ?? "";
    const name = /\bname="([^"]*)"/.exec(attrs)?.[1] ?? "";
    const classname = /\bclassname="([^"]*)"/.exec(attrs)?.[1] ?? "";
    const timeAttr = /\btime="([^"]*)"/.exec(attrs)?.[1];
    const time = timeAttr ? Number(timeAttr) : 0;
    let status: "pass" | "fail" | "skip" = "pass";
    let failure: string | undefined;
    if (/<skipped\b/.test(body)) status = "skip";
    // bun emits `<failure type="..." />` (self-closing) for assertion
    // failures and `<failure ...>stack</failure>` for thrown errors —
    // handle both shapes.
    const failMatch = /<failure\b([^>]*?)(?:\/>|>([\s\S]*?)<\/failure>)/.exec(body);
    if (failMatch) {
      status = "fail";
      const attrs = failMatch[1];
      const inner = failMatch[2] ? decodeXmlEntities(failMatch[2].trim()) : "";
      const msg = /\bmessage="([^"]*)"/.exec(attrs)?.[1];
      const type = /\btype="([^"]*)"/.exec(attrs)?.[1];
      const header = msg ? decodeXmlEntities(msg) : type ?? "test failed";
      failure = inner ? `${header}\n${inner}` : header;
    }
    cases.push({
      classname: decodeXmlEntities(classname),
      name: decodeXmlEntities(name),
      time,
      status,
      failure,
    });
  }
  return cases;
};

const COLOR = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
};

export const formatSummary = (results: FileResult[], totalMs: number): string => {
  let pass = 0;
  let fail = 0;
  let skip = 0;
  for (const f of results) {
    for (const c of f.cases) {
      if (c.status === "pass") pass++;
      else if (c.status === "fail") fail++;
      else skip++;
    }
  }
  const fileFails = results.filter((f) => f.exitCode !== 0 || f.cases.some((c) => c.status === "fail"));

  const lines: string[] = [];
  for (const f of fileFails) {
    lines.push(`${COLOR.red}✗${COLOR.reset} ${f.relPath}`);
    const failedCases = f.cases.filter((c) => c.status === "fail");
    for (const c of failedCases) {
      const label = c.classname ? `${c.classname} > ${c.name}` : c.name;
      lines.push(`  ${COLOR.red}× ${label}${COLOR.reset}`);
      if (c.failure) {
        for (const fl of c.failure.split("\n")) lines.push(`      ${COLOR.gray}${fl}${COLOR.reset}`);
      }
    }
    // bun's JUnit reporter only emits `<failure type="…" />` for assertion
    // failures — the diff/stack lives in stdout. Surface stdout when we have
    // failures OR when the file crashed before reporting at all (preload
    // crash, syntax error, unhandled rejection).
    if (f.output) {
      const header =
        f.cases.length === 0
          ? `  ${COLOR.gray}(no JUnit output — file crashed before reporting)${COLOR.reset}`
          : `  ${COLOR.gray}── stdout (last 40 lines) ──${COLOR.reset}`;
      lines.push(header);
      const tail = f.output.split("\n").slice(-40);
      for (const fl of tail) lines.push(`      ${COLOR.gray}${fl}${COLOR.reset}`);
    }
    lines.push("");
  }

  const totalFiles = results.length;
  const failedFiles = fileFails.length;
  const passedFiles = totalFiles - failedFiles;
  const totalMsFmt = `${(totalMs / 1000).toFixed(2)}s`;
  lines.push(
    `${COLOR.bold}Files${COLOR.reset}  ${COLOR.green}${passedFiles} pass${COLOR.reset}` +
      (failedFiles > 0 ? `, ${COLOR.red}${failedFiles} fail${COLOR.reset}` : "") +
      `  (${totalFiles})`,
  );
  lines.push(
    `${COLOR.bold}Tests${COLOR.reset}  ${COLOR.green}${pass} pass${COLOR.reset}` +
      (fail > 0 ? `, ${COLOR.red}${fail} fail${COLOR.reset}` : "") +
      (skip > 0 ? `, ${COLOR.yellow}${skip} skip${COLOR.reset}` : "") +
      `  (${pass + fail + skip})`,
  );
  lines.push(`${COLOR.bold}Time${COLOR.reset}   ${totalMsFmt}`);
  return lines.join("\n");
};
