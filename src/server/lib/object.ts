export const flatten = (obj: { [k: string]: any }) => {
  const set = new Set<[string, any]>();
  for (const key in obj) set.add([key, obj[key]]);

  const queue = set.values();
  let cue = queue.next();

  const map: { [k: string]: (string | number | boolean | null)[] } = {};

  while (cue.value) {
    const [address, any] = cue.value;
    const type = typeof any;

    if (type === "object") {
      if (Array.isArray(any)) {
        any.forEach((e) => set.add([address, e]));
      } else if (any !== null) {
        Object.entries(any).forEach(([key, value]) => {
          set.add([address + "." + key, value]);
        });
      }
    }

    if (type === "number" || type === "string" || type === "boolean" || any === null) {
      const existingData = map[address];
      if (existingData) existingData.push(any);
      else map[address] = [any];
    }

    cue = queue.next();
  }

  const result: any = {};

  for (const key in map) {
    const data = map[key];
    if (data.length === 1) result[key] = data[0];
    else result[key] = data;
  }

  return result;
};

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends (infer U)[]
    ? DeepPartial<U>[]
    : T[P] extends object
    ? DeepPartial<T[P]>
    : T[P];
};
