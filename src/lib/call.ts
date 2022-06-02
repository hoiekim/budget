export interface ApiResponse<T = undefined> {
  status: "loading" | "streaming" | "success" | "failed" | "error";
  data: T;
  info?: string;
}

export const call = async <T = any>(path: string, options?: RequestInit) => {
  const method = options?.method?.toUpperCase() || "GET";

  return fetch(path, options)
    .then((r) => r.json())
    .then((r: ApiResponse<T>) => {
      console.log(`<${method}> ${path}`, r);
      return r;
    });
};

export const read = async <T = any>(
  path: string,
  callback: (response: ApiResponse<T>) => any,
  options?: RequestInit
) => {
  const method = options?.method?.toUpperCase() || "GET";

  fetch(path, options)
    .then((r) => r.body)
    .then((r) => {
      if (!r) throw new Error("Response body is not found.");

      const reader = r.getReader();

      return new ReadableStream({
        start: async (controller) => {
          while (true) {
            const { done, value } = await reader.read();

            const response = JSON.parse(new TextDecoder().decode(value));
            console.log(`<${method}> ${path}`, response);
            callback(response);

            if (done) break;

            controller.enqueue(value);
          }

          controller.close();
          reader.releaseLock();
        },
      });
    })
    .then((r) => {
      console.log(`<${method}> ${path}`, r);
    })
    .catch((r) => {
      console.log(`<${method}> ${path}`, r);
    });
};
