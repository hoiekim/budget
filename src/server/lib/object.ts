export const flatten = (obj: Record<string, unknown>) => {
  const set = new Set<[string, unknown]>();
  for (const key in obj) set.add([key, obj[key]]);

  const queue = set.values();
  let cue = queue.next();

  type ValidDataType = string | number | boolean | null;
  const map: { [k: string]: ValidDataType | ValidDataType[] } = {};

  while (cue.value) {
    const [address, value] = cue.value;
    const type = typeof value;

    const isArray = Array.isArray(value);

    if (type === "object" && !isArray && value !== null) {
      Object.entries(value as Record<string, unknown>).forEach(([key, v]) => {
        set.add([address + "." + key, v]);
      });
    }

    if (
      isArray ||
      type === "number" ||
      type === "string" ||
      type === "boolean" ||
      value === null
    ) {
      const existingData = map[address];
      const validValue = value as ValidDataType;
      if (existingData) {
        if (!Array.isArray(existingData)) map[address] = [existingData, validValue];
        else existingData.push(validValue);
      } else {
        map[address] = validValue;
      }
    }

    cue = queue.next();
  }

  return map;
};
