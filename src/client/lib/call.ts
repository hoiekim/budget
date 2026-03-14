import { ApiResponse } from "server";

const call = async <T = unknown>(path: string, options?: RequestInit): Promise<ApiResponse<T>> => {
  const method = options?.method || "GET";
  const body = options?.body;

  const init: RequestInit | undefined = options;

  if (method === "POST") {
    (init as RequestInit).headers = { "Content-Type": "application/json" };
    (init as RequestInit).body = JSON.stringify(body);
  }

  try {
    const httpResponse = await fetch(path, init);
    const response: ApiResponse<T> = await httpResponse.json();
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Network or parse error";
    return { status: "error", message };
  }
};

call.get = <T>(path: string) => call<T>(path);
call.post = <T>(path: string, body: unknown) => call<T>(path, { method: "POST", body: body as BodyInit });
call.delete = <T>(path: string) => call<T>(path, { method: "DELETE" });

export { call };

const CACHE_KEY = "budget-cache";

// Lazy-initialize cache to avoid window reference during SSR/tests
let promisedCache: Promise<Cache> | undefined;
const getCache = () => {
  if (typeof window === "undefined") return undefined;
  if (!promisedCache) promisedCache = window.caches?.open(CACHE_KEY);
  return promisedCache;
};

export const cleanCache = () => typeof window !== "undefined" && window.caches?.delete(CACHE_KEY);

export const cachedCall = async <T = unknown>(path: string) => {
  const cache = await getCache();
  if (!cache) return call.get<T>(path);
  try {
    const cachedResponse = await cache.match(path);
    if (cachedResponse) {
      const result = await cachedResponse?.json();
      return result as ApiResponse<T>;
    } else {
      await cache.add(path);
      const cachedResponse = await cache.match(path);
      const result = await cachedResponse?.json();
      return result as ApiResponse<T>;
    }
  } catch (error) {
    console.error(error);
  }
};

export const read = async <T = unknown>(
  path: string,
  callback: (response: ApiResponse<T>) => void,
  options?: RequestInit,
) => {
  const response = await fetch(path, options);
  const reader = response.body?.getReader();
  if (!reader) return;

  let streamBuilder = "";

  const start = async (controller: ReadableStreamController<Uint8Array>) => {
    const push = async () => {
      try {
        const { done, value } = await reader.read();

        if (done) {
          controller.close();
          reader.releaseLock();
          return;
        }

        const text = new TextDecoder().decode(value);
        streamBuilder += text;

        if (streamBuilder.includes("\n")) {
          const splittedStream = streamBuilder.split("\n").filter((e) => e);
          splittedStream.forEach((e, i) => {
            let isError = false;

            try {
              const response: ApiResponse<T> = JSON.parse(e);
              callback(response);
            } catch (error) {
              console.error(error);
              isError = true;
            }

            if (i === splittedStream.length - 1) {
              streamBuilder = isError ? e : "";
            }
          });
        }

        controller.enqueue(value);

        push();
      } catch (error) {
        console.error(error);
      }
    };

    push();
  };

  return new ReadableStream({ start });
};
