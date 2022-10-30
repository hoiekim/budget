export const getDateString = (date: Date) => {
  return date.toISOString().split("T").shift() as string;
};

/**
 * @param dateString YYYY-MM-DD
 * @returns YYYY-MM-DDT00:00:00
 */
export const appendTimeString = (dateString: string) => {
  if (dateString.includes("T")) return dateString;
  return dateString + "T00:00:00";
};
