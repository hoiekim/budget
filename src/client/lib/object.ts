export const deepEqual = (x: any, y: any) => {
  return isSubset(x, y, (x, y) => Object.keys(x).length === Object.keys(y).length);
};

export const isSubset = (
  whole: any,
  part: any,
  extraCondition?: (whole: any, part: any) => boolean
) => {
  if (extraCondition && !extraCondition(whole, part)) return false;
  if (whole === part) return true;
  else if (whole && typeof whole === "object" && part && typeof part === "object") {
    for (const prop in part) {
      if (whole.hasOwnProperty(prop)) {
        if (!isSubset(whole[prop], part[prop])) return false;
      } else return false;
    }
    return true;
  } else return false;
};
