import { AccountType, InvestmentTransactionType } from "plaid";
import {
  Route,
  createManualInvestmentTransaction,
  getAccount,
  getSecurity,
  requireQueryString,
  validateFields,
  validationError,
} from "server";
import type { FieldSpec } from "server";

export type NewInvestmentTransactionGetResponse = {
  investment_transaction_id: string;
  name: string;
};

/** Largest magnitude a DECIMAL(15, 6) column holds: 9 integer digits + 6 decimals. */
const DECIMAL_15_6_MAX = 999999999.999999;

/**
 * The caller-supplied mint values, validated before any query. `date` is
 * calendar-checked by `type: "date"` (`isDateString` rejects 2026-02-30,
 * which the old digit-shape regex let through); `iso_currency_code` is
 * capped at the VARCHAR(10) column; `price` / `quantity` are bounded to
 * the DECIMAL(15, 6) range rather than merely finite — 1e300 is finite
 * but overflows the column. Price has no direction (min 0); quantity may
 * be negative (a reconciliation sale). All four are optional: absent
 * values fall back to the mint defaults.
 */
const NEW_INVESTMENT_TRANSACTION_QUERY_SPEC: FieldSpec[] = [
  { path: "date", type: "date" },
  { path: "iso_currency_code", type: "string", maxLength: 10 },
  { path: "price", type: "number", min: 0, max: DECIMAL_15_6_MAX },
  { path: "quantity", type: "number", min: -DECIMAL_15_6_MAX, max: DECIMAL_15_6_MAX },
];

/**
 * Mint a shell manual `investment_transactions` row. Unlike
 * `getNewTransactionRoute`, this is NOT gated on
 * `items.provider === MANUAL` — the motivating case (RSU/ESPP grants
 * that predate Plaid's 24-month window) lives on a Plaid-connected
 * brokerage account. Plaid sync inserts/updates rows keyed by its own
 * IDs; the `manual-<uuid>` prefix here has no collision surface, and
 * `source='manual'` keeps the intent auditable.
 */
export const getNewInvestmentTransactionRoute = new Route<NewInvestmentTransactionGetResponse>(
  "GET",
  "/new-investment-transaction",
  async (req) => {
    const { user } = req.session;
    if (!user) return { status: "failed", message: "Request user is not authenticated." };

    const accountResult = requireQueryString(req, "account_id");
    if (!accountResult.success) return validationError(accountResult.error!);
    const account_id = accountResult.data!;

    // Validate the mint values BEFORE any query: each of the four reaches a
    // column that rejects it, and the write would 500 + alarm. Absent (or
    // empty) values stay absent and fall back to the mint defaults; a
    // present-but-wrong value answers validationError (400, no alarm), and
    // no query reaches any table. Only present values are collected, so
    // `validateFields` skips the rest the way it skips absent optionals.
    const queryValues: Record<string, unknown> = {};
    if (req.query?.date) queryValues.date = req.query.date;
    if (req.query?.iso_currency_code) queryValues.iso_currency_code = req.query.iso_currency_code;
    if (req.query?.price) queryValues.price = Number(req.query.price);
    if (req.query?.quantity) queryValues.quantity = Number(req.query.quantity);
    const fieldsResult = validateFields(queryValues, NEW_INVESTMENT_TRANSACTION_QUERY_SPEC);
    if (!fieldsResult.success) return validationError(fieldsResult.error!);
    const date = queryValues.date as string | undefined;
    const iso_currency_code = queryValues.iso_currency_code as string | undefined;
    const price = queryValues.price as number | undefined;
    const quantity = queryValues.quantity as number | undefined;

    const account = await getAccount(user, account_id);
    if (!account) return { status: "failed", message: "Account not found." };
    // Match the FE gate: the `Add Investment Transaction` button
    // only renders on investment accounts. Enforce the same server-side
    // so a direct-URL caller can't mint an investment_transactions row
    // against a depository/credit account (the row wouldn't render as a
    // holding, but the data is still wrong).
    if (account.type !== AccountType.Investment) {
      return {
        status: "failed",
        message: "Investment transactions can only be created on investment accounts.",
      };
    }

    // `security_id` is optional — omitted when the user clicks the
    // account-level `Add Investment Transaction` button and picks
    // the security in the detail form (via ticker-lookup). Prefilled
    // when the user clicks the per-security `+` on the holding detail
    // page. When present, validate it resolves to a real security —
    // without this, a caller could pass a garbage string that
    // silently inserts and later breaks `data.securities.get()`
    // lookups on the FE (there's no FK on the column).
    const security_id_raw = req.query?.security_id ? String(req.query.security_id) : null;
    let security_id: string | null = null;
    if (security_id_raw) {
      const security = await getSecurity(security_id_raw);
      if (!security) {
        return { status: "failed", message: "Security not found." };
      }
      security_id = security_id_raw;
    }

    // Holding-derived defaults from the caller. The FE prefills
    // `price` with the security's latest `institution_price` and
    // `iso_currency_code` with the holding's currency, so the
    // shell starts with values the user can confirm/correct rather
    // than a 0 that quietly zeroes the MWR calc if abandoned.
    // (Validated above through `validateFields`; the values here are
    // the checked ones.)
    // `quantity` is prefilled when the FE knows the exact missing units
    // (divergence-flag "Add transaction for N missing units" action).
    // The caller reconciles the row it is asking for, so a negative quantity
    // arrives already named as a sale rather than being renamed here. Only
    // the two types that move shares are accepted: the mint creates a share
    // movement, and the others are reached by editing the row afterwards.
    const typeRaw = req.query?.type ? String(req.query.type) : "";
    const type =
      typeRaw === InvestmentTransactionType.Sell
        ? InvestmentTransactionType.Sell
        : typeRaw === InvestmentTransactionType.Buy
          ? InvestmentTransactionType.Buy
          : undefined;
    // `date` is prefilled by the divergence-reconciliation flow with
    // the earliest holdings-snapshot date that shows the surplus, so
    // the mint explains the phantom shares from THAT date forward
    // instead of only from today. Without this, a reconciliation buy
    // dated today closes the current-window divergence but leaves
    // every prior-month view still flagging the excess (the txn
    // walker only counts txns up to the window end). Format:
    // YYYY-MM-DD. Anything else is a validation error, not a silent
    // fall back to today — the caller asked for a specific date.
    const created = await createManualInvestmentTransaction(user, {
      account_id,
      security_id,
      price,
      iso_currency_code,
      quantity,
      type,
      date,
    });
    if (!created) {
      return { status: "failed", message: "Failed to create investment transaction." };
    }

    return {
      status: "success",
      body: {
        investment_transaction_id: created.investment_transaction_id,
        name: created.name,
      },
    };
  },
);
