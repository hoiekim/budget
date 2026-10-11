import { InvestmentTransactionType } from "plaid";

/**
 * The fields a share movement is described by, and the only ones this
 * normalizes. A row that moves no shares carries its value somewhere these
 * four cannot express, so it is left exactly as written.
 */
export type ShareMovingType = InvestmentTransactionType.Buy | InvestmentTransactionType.Sell;

export interface ShareMovement {
  type: InvestmentTransactionType;
  quantity: number;
  price: number;
  amount: number;
}

export const movesShares = (type: unknown): type is ShareMovingType =>
  type === InvestmentTransactionType.Buy || type === InvestmentTransactionType.Sell;

export const isNormalizableRow = <T extends { type: InvestmentTransactionType }>(
  source: string | null | undefined,
  row: T,
): row is T & { type: ShareMovingType } => source === "manual" && movesShares(row.type);

/**
 * Canonical form for a hand-entered share movement:
 *
 *   price    >= 0, a unit price has no direction
 *   quantity signed, positive when shares arrive
 *   type     buy when shares arrive, sell when they leave
 *   amount   price * quantity, so cash moves opposite to the shares
 *
 * `subtype` is deliberately not part of it. The editor offers the provider's
 * whole vocabulary — `sell short` and `buy to cover` are real choices a user
 * can make — so deriving one from the direction would quietly replace what
 * they picked.
 *
 * This is the convention the readers assume. Not every writer follows it —
 * see `isNormalizableRow` for the one that signs a movement the other way
 * round on purpose, which is why this is not applied to provider rows. The editor does not enforce it: it persists one field
 * group at a time, so `type`, `quantity`, `price` and `amount` can disagree
 * in any combination, and a reader electing any one of them as authoritative
 * is wrong for the rows where a different one is honest.
 */
export const isCanonical = (row: ShareMovement, sharesArrive?: boolean): boolean => {
  if (row.price < 0) return false;
  // `sharesArrive` pins WHICH direction, not merely that the fields agree on
  // one: both {buy, +5} and {sell, -5} satisfy every clause below.
  if (sharesArrive !== undefined && row.quantity !== 0) {
    if (sharesArrive !== row.quantity > 0) return false;
  }
  if (row.quantity > 0 && row.type !== InvestmentTransactionType.Buy) return false;
  if (row.quantity < 0 && row.type !== InvestmentTransactionType.Sell) return false;
  return Math.abs(row.amount - row.price * row.quantity) < 0.005;
};

/**
 * Which field the writer just edited, and therefore which one carries the
 * intent. The others are derived to agree with it.
 *
 * `quantity` and `type` pull opposite ways and both are right in their own
 * case. The reconciliation mint names a type and varies `quantity`, so a
 * negative quantity there means a sale and the type is a placeholder. Someone
 * picking Sell from the dropdown has said the opposite — the type is the
 * choice and the quantity's sign is stale. Only the writer knows which it is,
 * so it is passed in rather than inferred from the fields that changed.
 */
export type IntentField = "quantity" | "type" | "price";

/**
 * Rewrite a hand-entered share movement into canonical form, taking the
 * direction from whichever field the writer just supplied.
 *
 * Returns the whole canonical row; the caller decides which fields actually
 * changed, so an untouched column is never rewritten with its own value.
 */
export const normalizeShareMovement = (
  row: ShareMovement & { type: ShareMovingType },
  intent: IntentField,
): ShareMovement & { type: ShareMovingType } => {
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
/**
 * The fields a single edit should write, given the row it started from.
 *
 * Pure, and shared rather than living inside the editor, so the decision it
 * makes is reachable by a test without a rendered component.
 *
 * Only what moved is returned. A field the writer did not touch, and that
 * reconciliation agrees with, is left out so a concurrent edit of it is not
 * overwritten.
 */
export const shapePatchFor = (
  source: string | null | undefined,
  current: ShareMovement,
  intent: IntentField,
  edited: Partial<ShareMovement>,
): Partial<ShareMovement> => {
  const merged = { ...current, ...edited };

  // Both halves of the invariant are asserted here rather than split between
  // this and the caller's own guards: four of the six types the editor offers
  // move no shares, and a provider row is never reconciled at all because one
  // provider signs a movement the other way round on purpose.
  if (!isNormalizableRow(source, merged)) {
    const patch: Partial<ShareMovement> = { ...edited };
    if (intent !== "type") {
      patch.amount = Math.round(merged.quantity * merged.price * 100) / 100;
    }
    return patch;
  }

  const canonical = normalizeShareMovement({ ...merged, type: merged.type }, intent);
  const patch: Partial<ShareMovement> = {};
  if (canonical.type !== current.type) patch.type = canonical.type;
  if (canonical.quantity !== current.quantity) patch.quantity = canonical.quantity;
  if (canonical.price !== current.price) patch.price = canonical.price;
  if (canonical.amount !== current.amount) patch.amount = canonical.amount;
  return patch;
};
