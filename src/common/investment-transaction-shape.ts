import { InvestmentTransactionType } from "plaid";

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
 * `subtype` is deliberately outside it: the editor offers the provider's whole
 * vocabulary, so deriving one from the direction would replace a real choice.
 */
export const isCanonical = (row: ShareMovement, sharesArrive?: boolean): boolean => {
  if (row.price < 0) return false;
  // Pins WHICH direction, not merely that the fields agree on one: both
  // {buy, +5} and {sell, -5} satisfy every clause below.
  if (sharesArrive !== undefined && row.quantity !== 0) {
    if (sharesArrive !== row.quantity > 0) return false;
  }
  if (row.quantity > 0 && row.type !== InvestmentTransactionType.Buy) return false;
  if (row.quantity < 0 && row.type !== InvestmentTransactionType.Sell) return false;
  return Math.abs(row.amount - row.price * row.quantity) < 0.005;
};

/**
 * Which field the writer just edited; the others are derived to agree with it.
 *
 * `quantity` and `type` pull opposite ways and each is right in its own case —
 * the mint names a type and varies quantity, someone picking Sell means the
 * reverse — so the writer passes this rather than it being inferred.
 */
export type IntentField = "quantity" | "type" | "price";

/** The canonical form of a row, with direction taken from `intent`. */
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
        : // Magnitude only; direction stays where the row had it, and the row
          // may itself be uncanonical, so `type` decides only if quantity is 0.
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
 * The fields a single edit should write, given the row it started from.
 *
 * Only what moved: a field the writer did not touch, and that reconciliation
 * agrees with, is left out so a concurrent edit of it is not overwritten.
 */
export const shapePatchFor = (
  source: string | null | undefined,
  current: ShareMovement,
  intent: IntentField,
  edited: Partial<ShareMovement>,
): Partial<ShareMovement> => {
  const merged = { ...current, ...edited };

  // Both halves here rather than split with the caller: four of the six types
  // move no shares, and a provider row is never reconciled at all — one
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
