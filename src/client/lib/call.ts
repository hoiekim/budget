import { ApiResponse } from "server";

const call = async <T = any>(path: string, options?: RequestInit) => {
  const method = options?.method || "GET";
  const body = options?.body;

  const init: RequestInit | undefined = options;

  if (method === "POST") {
    (init as RequestInit).headers = { "Content-Type": "application/json" };
    (init as RequestInit).body = JSON.stringify(body);
  }

  const response: ApiResponse<T> = await fetch(path, init).then((r) => {
    return r.json();
  });

  console.log(`<${method}> ${path}`, response);

  return response;
};

call.get = <T>(path: string) => call<T>(path);
call.post = <T>(path: string, body: any) => call<T>(path, { method: "POST", body });
call.delete = <T>(path: string) => call<T>(path, { method: "DELETE" });

export { call };

const CACHE_KEY = "budget-cache";

const promisedCache = caches.open(CACHE_KEY);
const getCache = () => promisedCache;

export const cleanCache = () => caches.delete(CACHE_KEY);

export const cachedCall = async <T = any>(path: string) => {
  try {
    const cache = await getCache();
    const cachedResponse = await cache.match(path);
    if (cachedResponse) {
      const result = await cachedResponse?.json();
      console.log(`<GET> <Cahced> ${path}`, result);
      return result as ApiResponse<T>;
    } else {
      await cache.add(path);
      const cachedResponse = await cache.match(path);
      const result = await cachedResponse?.json();
      console.log(`<GET> ${path}`, result);
      return result as ApiResponse<T>;
    }
  } catch (error) {
    console.error(error);
  }
};

export const read = async <T = any>(
  path: string,
  callback: (response: ApiResponse<T>) => any,
  options?: RequestInit
) => {
  const method = options?.method?.toUpperCase() || "GET";

  const response = await fetch(path, options);
  const reader = response.body?.getReader();
  if (!reader) return;

  let streamBuilder = "";

  const start = async (controller: ReadableStreamController<any>) => {
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
              console.log(`<${method}> ${path}`, response);
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
