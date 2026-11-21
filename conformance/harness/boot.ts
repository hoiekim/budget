/**
 * Starting a server that is expected to refuse to start: a setting it reads
 * at boot is wrong. `startStack` is for servers that come up; this runs the
 * same command with the given environment, waits for the process to exit,
 * and hands back its exit code and everything it printed.
 */
import net from "node:net";
import { POSTGRES, REPO_ROOT, TARGET, VERBOSE, serverCommand } from "./config";

export interface FailedStart {
  exitCode: number;
  /** Standard output and standard error together, colors removed. */
  output: string;
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });

const stripColors = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");

/**
 * Runs the server under test with `env` over a minimal environment and
 * resolves once it has exited. Throws if it is still running after
 * `timeoutMs`: it started after all, or hung.
 *
 * The database named is one that does not exist, so a server that wrongly
 * gets past its settings cannot touch anything.
 */
export const startExpectingFailure = async (
  env: Record<string, string | undefined>,
  { timeoutMs = 30_000 } = {},
): Promise<FailedStart> => {
  const full: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TZ: process.env.TZ ?? "UTC",
    PORT: String(await freePort()),
    POSTGRES_HOST: POSTGRES.host,
    POSTGRES_PORT: String(POSTGRES.port),
    POSTGRES_USER: POSTGRES.user,
    POSTGRES_PASSWORD: POSTGRES.password,
    POSTGRES_DATABASE: "conformance_never_created",
    LOG_LEVEL: "info",
    ...env,
  };
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(full)) if (value !== undefined) cleaned[key] = value;

  const child = Bun.spawn({ cmd: serverCommand(), cwd: REPO_ROOT, env: cleaned, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const exitCode = await child.exited;
  clearTimeout(timer);
  const [out, err] = await output;
  const text = stripColors(out + err);
  if (VERBOSE) console.log(`[${TARGET}: expected not to start]\n${text}`);
  if (child.signalCode !== null) {
    throw new Error(`the ${TARGET} server did not exit within ${timeoutMs} ms; it printed:\n${text}`);
  }
  return { exitCode, output: text };
};
