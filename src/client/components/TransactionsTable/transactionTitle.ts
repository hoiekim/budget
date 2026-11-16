/** The name a transaction row shows: the user's memo, else the merchant, else the raw name. */
export const getTransactionTitle = (
  memo: string | null | undefined,
  merchantName: string | null | undefined,
  name: string | null | undefined,
) => memo || merchantName || name || "";
