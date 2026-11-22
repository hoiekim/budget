/**
 * Ports for the servers under test.
 *
 * A port the operating system picked (listening on port 0) and then released
 * is not safe to hand to a server: until the server binds it, a fake
 * upstream, the Postgres pool or any outgoing connection, in this suite or in
 * the other target's suite running alongside, can be given the same port from
 * the ephemeral range (32768 and up on Linux, 49152 and up on macOS). Then the
 * server fails to start, or a request meant for it reaches someone else.
 *
 * So each target takes its servers' ports from a band of its own below that
 * range, one after another, skipping any that are taken. Nothing is handed a
 * port there unless it asks for it by number.
 */
import net from "node:net";
import { canListenOnIpv6 } from "./address";
import { TARGET, type Target } from "./config";

const BANDS: Record<Target, [number, number]> = { bun: [20000, 24999], rust: [25000, 29999] };

let next: number | undefined;

/** Whether `port` can be listened on the way the servers do: on `::` where the host has IPv6. */
const isFree = async (port: number): Promise<boolean> => {
  const host = (await canListenOnIpv6()) ? "::" : "0.0.0.0";
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host, ipv6Only: false, exclusive: true }, () => server.close(() => resolve(true)));
  });
};

export const serverPort = async (): Promise<number> => {
  const [low, high] = BANDS[TARGET];
  // A random start, so a run that follows another closely does not begin on
  // ports the last one left in TIME_WAIT.
  next ??= low + Math.floor(Math.random() * (high - low + 1));
  for (let tried = 0; tried <= high - low; tried++) {
    const port: number = next;
    next = port >= high ? low : port + 1;
    if (await isFree(port)) return port;
  }
  throw new Error(`no free port for the ${TARGET} server between ${low} and ${high}`);
};
