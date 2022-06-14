import { Transaction, AccountBase } from "plaid";
import { ApiResponse } from "server";

export const Cache = {
  transactions: new Map<string, Transaction>(),
  accounts: new Map<string, AccountBase>(),
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

      const response: ApiResponse<T> = JSON.parse(
        new TextDecoder().decode(value)
      );
      console.log(`<${method}> ${path}`, response);
      callback(response);

      if (done) break;

      controller.enqueue(value);
    }

    controller.close();
    reader.releaseLock();
  };

  return new ReadableStream({ start });
};