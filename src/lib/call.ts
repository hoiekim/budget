interface ApiResponse {
  status: "loading" | "success" | "failed" | "error";
  data?: any;
  info?: string;
}

const cache = new Map<any, ApiResponse>();

const call = async (
  path: string,
  options?: RequestInit & { noCache?: boolean }
) => {
  const method = options?.method?.toUpperCase() || "GET";
  const useCache = !options?.noCache && method === "GET";
  const cacheExists = cache.get(path)?.status === "success";
  const loading = cache.get(path)?.status === "loading";

  if ((useCache && cacheExists) || loading) return cache.get(path);

  cache.set(path, { status: "loading" });

  return fetch(path, options)
    .then((r) => r.json())
    .then((r) => {
      console.log(`<${method}> ${path}`, r);
      cache.set(path, r);
      return r;
    });
};

export default call;
