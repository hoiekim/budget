export const numberToCommaString = (n: number) => {
  const splitNumberString = n.toString().split(".");
  const natural = splitNumberString[0];
  const float = splitNumberString[1];
  const { length } = natural;
  let builder = "";
  let i = 0;
  let skip = length % 3;
  while (i < length) {
    if (i && !((i - skip) % 3)) builder += ",";
    builder += natural[i];
    i++;
  }
  return builder + (float ? "." + float : "");
};
