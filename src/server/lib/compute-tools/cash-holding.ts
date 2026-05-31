import { AccountType } from "plaid";
import {
  getDateString,
  getRandomId,
  JSONAccount,
  JSONHolding,
  JSONSecurity,
} from "common";
import { searchSecurities, upsertSecurities } from "server";

/**
 * Single canonical ticker for the auto-inferred USD cash holding. Plaid
 * itself uses tickers like `CUR:USD` for cash-equivalent securities; we
 * deliberately pick a different label so the inferred-cash row is
 * distinguishable from a broker-reported one at the data layer, but the
 * UI treats them identically: Plaid-provided and inferred cash render
 * the same in every holdings view.
 */
const USD_CASH_TICKER = "USD";

/**
 * Returns the global "USD Cash" security, creating it on first use.
 * The securities table is keyed on `ticker_symbol`, so multiple users
 * end up sharing the same row — which is fine because the cash position
 * itself lives on the per-user holding, not the security.
 */
export const ensureUSDCashSecurity = async (): Promise<JSONSecurity> => {
  const existing = await searchSecurities({ ticker_symbol: USD_CASH_TICKER });
  if (existing.length > 0) return existing[0];

  const today = getDateString();
  const newSecurity: JSONSecurity = {
    security_id: getRandomId(),
    ticker_symbol: USD_CASH_TICKER,
    name: "US Dollar Cash",
    type: "cash",
    close_price: 1,
    close_price_as_of: today,
    iso_currency_code: "USD",
    isin: null,
    cusip: null,
    sedol: null,
    institution_security_id: null,
    institution_id: null,
    proxy_security_id: null,
    is_cash_equivalent: true,
    update_datetime: null,
    unofficial_currency_code: null,
    market_identifier_code: null,
    sector: null,
    industry: null,
    option_contract: null,
    fixed_income: null,
  };
  await upsertSecurities([newSecurity]);
  return newSecurity;
};

const isCashLikeSecurity = (sec: JSONSecurity | undefined): boolean => {
  if (!sec) return false;
  if (sec.type === "cash") return true;
  if (sec.is_cash_equivalent) return true;
  // Plaid's `CUR:USD` / `CUR:EUR` style tickers for currency.
  if (sec.ticker_symbol && sec.ticker_symbol.startsWith("CUR:")) return true;
  return false;
};

/**
 * Holding-shaped cash detector. Mirrors the FE's `isCash` heuristic
 * (`HoldingsComposition`): cash holdings always quote `institution_price = 1`
 * and never carry a real cost basis. This catches money-market funds and
 * broker-proprietary cash sweeps that don't surface as `type='cash'` /
 * `is_cash_equivalent` / `CUR:*` at the *security* layer (#368).
 *
 * Falsy `cost_basis` covers both DB-NULL and the `?? 0` collapse that
 * happens on serialisation, so this matches whether the holding came
 * straight from Plaid or round-tripped through the snapshot model.
 */
const isHoldingCashLike = (h: JSONHolding, sec: JSONSecurity | undefined): boolean => {
  if (isCashLikeSecurity(sec)) return true;
  if (h.institution_price === 1 && (h.cost_basis === null || h.cost_basis === 0)) return true;
  return false;
};

/**
 * Threshold (USD) below which we treat the broker-reported delta as
 * accumulated noise (pending sweeps, rounding) and skip inferring a row.
 * Picked low enough to catch real cash positions, high enough to avoid
 * showing a $0.03 phantom holding.
 */
const CASH_INFERENCE_MIN = 0.01;

/**
 * For each investment account that doesn't already have a cash-like
 * holding, synthesise one to cover the broker-reported delta:
 *
 *     inferred_cash = max(0, account.balances.current − Σ(non-cash holdings))
 *
 * Returns the array of new holdings to merge into the sync's
 * `incomingHoldings` list. The downstream `upsertAndDeleteHoldingsWithSnapshots`
 * then writes each as a normal holding snapshot — the UI sees no difference
 * between Plaid-reported and inferred cash.
 *
 * Forward-only: we don't try to infer historical cash positions. The
 * inferred row gets a fresh snapshot dated now, and future syncs either
 * update it (if Plaid still doesn't report cash) or supersede it (if
 * Plaid starts reporting cash as a real holding).
 */
export const inferCashHoldings = async (
  accounts: JSONAccount[],
  incomingHoldings: JSONHolding[],
  securities: JSONSecurity[],
): Promise<JSONHolding[]> => {
  const securityById = new Map(securities.map((s) => [s.security_id, s]));
  const result: JSONHolding[] = [];
  let cashSecurity: JSONSecurity | null = null;

  for (const account of accounts) {
    if (account.type !== AccountType.Investment) continue;

    const accountHoldings = incomingHoldings.filter((h) => h.account_id === account.account_id);

    const hasCash = accountHoldings.some((h) =>
      isHoldingCashLike(h, securityById.get(h.security_id)),
    );
    if (hasCash) continue;

    const nonCashTotal = accountHoldings.reduce((s, h) => {
      if (h.institution_value !== null && h.institution_value !== undefined)
        return s + h.institution_value;
      const qty = h.quantity ?? 0;
      const price = h.institution_price ?? 0;
      return s + price * qty;
    }, 0);
    const balanceCurrent = account.balances?.current ?? 0;
    const inferredCash = Math.max(0, balanceCurrent - nonCashTotal);
    if (inferredCash < CASH_INFERENCE_MIN) continue;

    // Lazy-resolve the cash security only once, only when needed.
    if (!cashSecurity) cashSecurity = await ensureUSDCashSecurity();

    result.push({
      holding_id: `${account.account_id}-${cashSecurity.security_id}`,
      account_id: account.account_id,
      security_id: cashSecurity.security_id,
      quantity: inferredCash,
      institution_price: 1,
      institution_price_as_of: new Date().toISOString(),
      institution_value: inferredCash,
      cost_basis: inferredCash,
      iso_currency_code: account.balances?.iso_currency_code ?? "USD",
      unofficial_currency_code: null,
    });
  }

  return result;
};
