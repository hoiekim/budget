import { describe, test, expect, mock } from "bun:test";
import { JsonStream } from "./route";

async function* batches<T>(...groups: T[][]): AsyncGenerator<T[]> {
  for (const group of groups) yield group;
}

const read = (stream: JsonStream<unknown>, onError = () => {}) =>
  new Response(stream.toReadableStream(onError)).text();

describe("JsonStream", () => {
  test("writes the same JSON as stringifying the materialized value", async () => {
    const rows = [
      { id: "a", amount: 1.5, tags: ["x"], meta: null },
      { id: "b", amount: -2, tags: [], meta: { nested: true } },
      { id: "c", amount: 0, tags: ["y", "z"], meta: null },
    ];
    const date = new Date("2026-10-22T00:00:00.000Z");
    const streamed = new JsonStream({
      status: "success",
      message: undefined,
      body: {
        rows: batches([rows[0], rows[1]], [], [rows[2]]),
        empty: batches(),
        plain: [1, 2],
        when: date,
        label: 'quote " and \\ backslash',
      },
    } as never);

    const text = await read(streamed);

    expect(text).toBe(
      JSON.stringify({
        status: "success",
        body: { rows, empty: [], plain: [1, 2], when: date, label: 'quote " and \\ backslash' },
      }),
    );
    expect(JSON.parse(text).body.rows).toEqual(rows);
  });

  test("a body that is itself batched becomes a top-level array", async () => {
    const text = await read(new JsonStream({ status: "success", body: batches([1, 2], [3]) } as never));
    expect(text).toBe('{"status":"success","body":[1,2,3]}');
  });

  test("a batch that throws mid-response reports the error and fails the stream", async () => {
    async function* failing(): AsyncGenerator<number[]> {
      yield [1];
      throw new Error("connection lost");
    }
    const onError = mock(() => {});
    const stream = new JsonStream({ status: "success", body: failing() } as never);

    await expect(read(stream, onError)).rejects.toThrow("connection lost");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("a cancelled response stops pulling batches", async () => {
    let finished = false;
    let pulled = 0;
    async function* endless(): AsyncGenerator<number[]> {
      try {
        while (true) {
          pulled++;
          yield [pulled];
        }
      } finally {
        finished = true;
      }
    }
    const reader = new JsonStream({ status: "success", body: endless() } as never)
      .toReadableStream(() => {})
      .getReader();

    let text = "";
    while (pulled < 2) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();

    expect(text).toContain('"body":[1');
    expect(finished).toBe(true);
    expect(pulled).toBeLessThan(5);
  });
});
