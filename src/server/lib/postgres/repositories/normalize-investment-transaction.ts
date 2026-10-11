import { InvestmentTransactionType, InvestmentTransactionSubtype } from "plaid";

/**
 * The fields a share movement is described by, and the only ones this
 * normalizes. A row that moves no shares carries its value somewhere these
 * four cannot express, so it is left exactly as written.
 */
export interface ShareMovement {
  type: InvestmentTransactionType;
  subtype?: InvestmentTransactionSubtype | null;
  quantity: number;
  price: number;
  amount: number;
}

/**
 * Canonical form for a hand-entered share movement:
 *
 *   price    >= 0, a unit price has no direction
 *   quantity signed, positive when shares arrive
 *   type     buy when shares arrive, sell when they leave
 *   amount   price * quantity, so cash moves opposite to the shares
 *
 * This is the convention every provider already writes and every reader
 * already assumes. The editor does not enforce it: it persists one field
 * group at a time, so `type`, `quantity`, `price` and `amount` can disagree
 * in any combination, and a reader electing any one of them as authoritative
 * is wrong for the rows where a different one is honest.
 */
export const isCanonical = (row: ShareMovement): boolean => {
  if (row.price < 0) return false;
  if (row.quantity > 0 && row.type !== InvestmentTransactionType.Buy) return false;
  if (row.quantity < 0 && row.type !== InvestmentTransactionType.Sell) return false;
  return Math.abs(row.amount - row.price * row.quantity) < 0.005;
};

/**
 * Which field the writer just touched, and therefore which one carries the
 * intent. The others are derived to agree with it.
 *
 * `quantity` and `type` pull opposite ways and both are right in their own
 * case. The reconciliation mint hardcodes `type` and varies `quantity`, so a
 * negative quantity there means a sale and the type is a placeholder. Someone
 * picking Sell from the dropdown has said the opposite — the type is the
 * choice and the quantity's sign is stale. Reading the edit rather than the
 * row is what tells the two apart.
 */
export type IntentField = "quantity" | "type" | "price";

export const intentOf = (patched: Iterable<string>): IntentField => {
  const fields = new Set(patched);
  if (fields.has("type")) return "type";
  if (fields.has("quantity")) return "quantity";
  return "price";
};

/**
 * Rewrite a hand-entered share movement into canonical form, taking the
 * direction from whichever field the writer just supplied.
 *
 * Returns the whole canonical row; the caller decides which fields actually
 * changed, so an untouched column is never rewritten with its own value.
 */
export const normalizeShareMovement = (
  row: ShareMovement,
  intent: IntentField,
): ShareMovement & { subtype: InvestmentTransactionSubtype } => {
  const price = Math.abs(row.price);
  const shares = Math.abs(row.quantity);

  const sharesArrive =
    intent === "type"
      ? row.type === InvestmentTransactionType.Buy
      : intent === "quantity"
        ? row.quantity >= 0
        : // A price edit changes magnitude only, so direction stays where the
          // row already had it — and the row may itself be uncanonical, which
          // is why `type` decides only when `quantity` is silent.
          (row.quantity || 0) !== 0
          ? row.quantity > 0
          : row.type === InvestmentTransactionType.Buy;

  const quantity = sharesArrive ? shares : -shares;

  return {
    type: sharesArrive ? InvestmentTransactionType.Buy : InvestmentTransactionType.Sell,
    subtype: sharesArrive ? InvestmentTransactionSubtype.Buy : InvestmentTransactionSubtype.Sell,
    quantity,
    price,
    amount: Math.round(price * quantity * 100) / 100,
  };
};

/**
 * Only a hand-entered purchase or sale is rewritten.
 *
 * Every provider writes rows this already describes correctly, and one of
 * them signs a movement the other way round on purpose — normalizing those
 * would turn its withdrawals into deposits. A type that moves no shares is
 * left alone because its value does not live in `price * quantity`, so there
 * is nothing here to make consistent.
 */
export const isNormalizableRow = (source: string | null | undefined, type: unknown): boolean =>
  source === "manual" &&
  (type === InvestmentTransactionType.Buy || type === InvestmentTransactionType.Sell);
