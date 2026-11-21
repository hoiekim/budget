/**
 * Runs once before the conformance test files. Removes the sandbox's own
 * proxy settings from this process, so the test client talks to the server
 * under test directly; the servers get a proxy of their own (see stack.ts).
 */
for (const name of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
  delete process.env[name];
}
process.env.NO_PROXY = "*";
process.env.no_proxy = "*";
