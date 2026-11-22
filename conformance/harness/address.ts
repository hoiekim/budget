/**
 * The address a server under test reports for a connection from this
 * process. Both servers listen the way `Bun.serve` does when given no
 * hostname: on `::` with IPv6-only off where the host can open an IPv6
 * socket, so an IPv4 client reads `::ffff:127.0.0.1` there, and on `0.0.0.0`
 * where it cannot, so it reads `127.0.0.1`. Which one depends on the machine,
 * not on the server, so a test that names the address asks here.
 */
import net from "node:net";

let known: Promise<string> | undefined;

const canListenOnIpv6 = (): Promise<boolean> =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ port: 0, host: "::", ipv6Only: false }, () => server.close(() => resolve(true)));
  });

export const loopbackAddress = (): Promise<string> =>
  (known ??= canListenOnIpv6().then((ipv6) => (ipv6 ? "::ffff:127.0.0.1" : "127.0.0.1")));
