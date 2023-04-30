export const flatten = (obj: { [k: string]: any }) => {
  const set = new Set<[string, any]>();
  for (const key in obj) set.add([key, obj[key]]);

  const queue = set.values();
  let cue = queue.next();

  type ValidDataType = string | number | boolean | null;
  const map: { [k: string]: ValidDataType | ValidDataType[] } = {};

  while (cue.value) {
    const [address, any] = cue.value;
    const type = typeof any;

    const isArray = Array.isArray(any);

    if (type === "object" && !isArray && any !== null) {
      Object.entries(any).forEach(([key, value]) => {
        set.add([address + "." + key, value]);
      });
    }

    if (
      isArray ||
      type === "number" ||
      type === "string" ||
      type === "boolean" ||
      any === null
    ) {
      const existingData = map[address];
      if (existingData) {
        if (!Array.isArray(existingData)) map[address] = [existingData, any];
        else existingData.push(any);
      } else {
        map[address] = any;
      }
    }

    cue = queue.next();
  }

  return map;
};

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends (infer U)[]
    ? DeepPartial<U>[]
    : T[P] extends object
    ? DeepPartial<T[P]>
    : T[P];
};
