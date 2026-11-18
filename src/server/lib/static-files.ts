import path from "path";
import { responseSecurityHeaders } from "./security-headers";

/**
 * Serves a client file from `clientPath`, falling back to `index.html` for
 * SPA routes. The document is the response a browser enforces CSP and
 * X-Frame-Options from, so it carries the same security headers as the API.
 */
export const serveStatic = async (clientPath: string, pathname: string): Promise<Response> => {
  const indexPath = path.join(clientPath, "index.html");
  const file = Bun.file(pathname === "/" ? indexPath : path.join(clientPath, pathname));
  return new Response((await file.exists()) ? file : Bun.file(indexPath), {
    headers: responseSecurityHeaders(),
  });
};
