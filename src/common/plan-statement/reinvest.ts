import { InvestmentTransactionType } from "plaid";
import { PLAN_STATEMENT_ID_PREFIX, REINVESTED_DISTRIBUTION } from "../constants";
import { positionBefore, type EnteredPosition, type Movement } from "../holding-positions";
import { hash128 } from "../utils/hash";
import { KIND_SPECS, getCashLegId, type DailyClose, type PlannedTransaction } from "./plan";

export interface Distribution {
  /** YYYY-MM-DD */
  ex_date: string;
  /** Cash paid per share. */
  cash_amount: number;
  /** The fund's raw close on the ex-date, which the payout is reinvested at. */
  close: number;
}

/** What a reinvestment was inferred from, kept on its row. */
export interface ReinvestedDistribution {
  ex_date: string;
  cash_amount_per_share: number;
  shares_held: number;
}

/**
 * Smaller steps in the adjusted-to-raw ratio than this share of the prior
 * close are the provider's rounding, not a payout.
 */
const MIN_DISTRIBUTION_YIELD = 1e-4;

const round = (value: number, places: number) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/**
 * The cash distributions a fund went ex on within its bars. An adjusted
 * series scales every close before an ex-date by `1 - payout / prior close`,
 * so the ratio of adjusted to raw close steps by that factor on the ex-date.
 *
 * @example
 * // A $1 payout on a $100 fund: the adjusted close before the ex-date is 99% of the raw one.
 * distributionsFromCloses([
 *   { date: "2026-03-24", close: 100, adjustedClose: 99 },
 *   { date: "2026-03-25", close: 99.5, adjustedClose: 99.5 },
 * ]); // [{ ex_date: "2026-03-25", cash_amount: 1, close: 99.5 }]
 */
export const distributionsFromCloses = (bars: DailyClose[]): Distribution[] => {
  const distributions: Distribution[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prior = bars[i - 1];
    const bar = bars[i];
    const payoutShare = 1 - prior.adjustedClose / prior.close / (bar.adjustedClose / bar.close);
    if (payoutShare <= MIN_DISTRIBUTION_YIELD) continue;
    distributions.push({ ex_date: bar.date, cash_amount: round(prior.close * payoutShare, 6), close: bar.close });
  }
  return distributions;
};

/** One id per holding and ex-date, so a later import recognises the reinvestment it already wrote. */
export const getReinvestmentId = (account_id: string, security_id: string, ex_date: string) =>
  `${PLAN_STATEMENT_ID_PREFIX}${hash128([account_id, security_id, ex_date, REINVESTED_DISTRIBUTION].join("\0"))}`;

export interface ReinvestmentInput {
  account_id: string;
  security_id: string;
  iso_currency_code: string;
  /** The public fund's daily closes, as traded and dividend-adjusted. */
  bars: DailyClose[];
  /**
   * YYYY-MM-DD: ex-dates after `after` (the account's last row before the statement, or null for none)
   * through the statement's last row are inferred.
   */
  after: string | null;
  through: string;
  /** The holding's live movements, with the rows this import writes. */
  movements: Movement[];
  entered: EnteredPosition[];
  /** Whether the holding's entered positions are being replaced by its transactions. */
  replace: boolean;
  /** Ids already in the account: live, or found deleted by an earlier import attempt. */
  existingIds: Set<string>;
}

/**
 * The reinvested distributions a holding restated from a collective trust is
 * owed: the trust keeps its payouts in its unit price, while the public fund
 * pays them out. On each ex-date in the statement's period, the shares
 * held at the start of the day × cash per share buys shares at that day's
 * close, as a dividend and its reinvestment. An ex-date already written is
 * left as it is; earlier reinvestments count toward the shares held on later ones.
 */
export const planReinvestments = (input: ReinvestmentInput): PlannedTransaction[] => {
  const { account_id, security_id, iso_currency_code, after, through, entered, replace, existingIds } = input;
  const spec = KIND_SPECS.dividend;
  const planned: Movement[] = [];
  const transactions: PlannedTransaction[] = [];

  for (const { ex_date, cash_amount, close } of distributionsFromCloses(input.bars)) {
    if (ex_date > through) break;
    if (after !== null && ex_date <= after) continue;
    const id = getReinvestmentId(account_id, security_id, ex_date);
    if (existingIds.has(id)) continue;
    const held = positionBefore({ movements: [...input.movements, ...planned], entered, replace, date: ex_date });
    const shares_held = round(held.quantity, 6);
    const amount = round(shares_held * cash_amount, 2);
    if (amount <= 0) continue;
    const quantity = amount / close;

    planned.push({
      investment_transaction_id: id,
      date: ex_date,
      type: InvestmentTransactionType.Buy,
      quantity,
      amount,
      price: close,
    });
    transactions.push(
      {
        transaction: {
          investment_transaction_id: id,
          account_id,
          security_id,
          date: ex_date,
          name: spec.name,
          amount,
          quantity,
          price: close,
          iso_currency_code,
          type: InvestmentTransactionType.Buy,
          subtype: spec.subtype,
          source: "manual",
        },
        reinvested_distribution: { ex_date, cash_amount_per_share: cash_amount, shares_held },
      },
      {
        transaction: {
          investment_transaction_id: getCashLegId(id),
          account_id,
          security_id: null,
          date: ex_date,
          name: spec.cash!.name,
          amount: -amount,
          quantity: 0,
          price: 0,
          iso_currency_code,
          type: InvestmentTransactionType.Cash,
          subtype: spec.cash!.subtype,
          source: "manual",
        },
      },
    );
  }
  return transactions;
};
