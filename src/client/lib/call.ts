import { ApiResponse, Account, Transaction, Institution } from "server";

export const Cache = {
  transactions: new Map<string, Transaction>(),
  accounts: new Map<string, Account>(),
  institutions: new Map<string, Institution>(),
};

export const call = async <T = any>(path: string, options?: RequestInit) => {
  const method = options?.method?.toUpperCase() || "GET";

  const response: ApiResponse<T> = await fetch(path, options).then((r) => {
    return r.json();
  });
  console.log(`<${method}> ${path}`, response);

  return response;
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

  const start = async (controller: ReadableStreamController<any>) => {
    while (true) {
      const { done, value } = await reader.read();
      const text = new TextDecoder().decode(value);

      text.split("\n").forEach((e) => {
        const response: ApiResponse<T> = JSON.parse(e);
        console.log(`<${method}> ${path}`, response);
        callback(response);
      });

      if (done) break;

      controller.enqueue(value);
    }

    controller.close();
    reader.releaseLock();
  };

  return new ReadableStream({ start });
};
