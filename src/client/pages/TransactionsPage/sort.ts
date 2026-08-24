import {
  AccountDictionary,
  BudgetDictionary,
  CategoryDictionary,
  InstitutionDictionary,
  InvestmentTransaction,
  SectionDictionary,
  SplitTransaction,
  Transaction,
  TransactionDictionary,
  TransactionFamilies,
  applySortings,
  type Sorter,
} from "client";
import type {
  InvestmentTransactionHeaders,
  TransactionHeaders,
  TransactionsPageType,
} from "client/components";
import { LocalDate } from "common";

export type TransactionRow = Transaction | SplitTransaction | InvestmentTransaction;
export type TransactionHeaderSet = TransactionHeaders & InvestmentTransactionHeaders;
export type TransactionSortKey = keyof TransactionHeaderSet;

/**
 * Lookup tables the ordering pipeline resolves a row's display values
 * against. Column sorting and search scoring both rank rows by what the
 * row *renders* (the account's custom name, the budget's name) rather
 * than by the foreign key it stores, so both read from the same set.
 */
export interface OrderingContext {
  accounts: AccountDictionary;
  institutions: InstitutionDictionary;
  budgets: BudgetDictionary;
  sections: SectionDictionary;
  categories: CategoryDictionary;
  transactions: TransactionDictionary;
  transactionFamilies: TransactionFamilies;
}

/**
 * Storage slot for the sort preferences. Distinct per type-filter
 * combination so e.g. an "expenses" sort doesn't collide with an
 * "expenses,transfers" sort, and distinct per row-type view because the
 * investment header set is a strict subset of the cash one.
 * `"investment"` is not a `TransactionsPageType`, so it cannot collide
 * with any filter combination.
 */
export const buildSortKey = (isInvestment: boolean, types: TransactionsPageType[]): string =>
  ["transactions", ...(isInvestment ? ["investment"] : []), ...types].join("_");

const accountName = (account_id: string, ctx: OrderingContext): string => {
  const account = ctx.accounts.get(account_id);
  return account?.custom_name || account?.name || "";
};

const institutionName = (account_id: string, ctx: OrderingContext): string => {
  const account = ctx.accounts.get(account_id);
  return ctx.institutions.get(account?.institution_id || "")?.name || "";
};

/**
 * The `Transaction` a row displays and sorts as: a whole transaction is
 * itself, a split presents its parent's fields (name, merchant, dates,
 * location) carrying its own id, amount and label.
 *
 * Same composition as `SplitTransaction.toTransaction`, but the parent
 * is resolved off `ctx` — the model method reads the `globalData`
 * module singleton, which a caller handed an explicit set of
 * dictionaries has no way to influence, and which leaves the split arm
 * inert in any test that populates a context instead.
 */
const asTransaction = (e: Transaction | SplitTransaction, ctx: OrderingContext): Transaction => {
  if (e instanceof Transaction) return e;
  const parent = ctx.transactions.get(e.transaction_id);
  return new Transaction({
    account_id: e.account_id,
    ...parent,
    transaction_id: e.id,
    amount: e.amount,
    label: e.label,
  });
};

/**
 * Resolve the value a row sorts by for a given column header. Shared by
 * both branches of `filteredAndSorted` — the investment view and the
 * cash view render different header sets but overlap on `date` /
 * `amount`, and those must order rows the same way in both.
 */
export const formatSortValue = (
  e: TransactionRow,
  key: TransactionSortKey,
  ctx: OrderingContext,
): string | number | Date | unknown => {
  if (e instanceof InvestmentTransaction) {
    if (key === "date") {
      return new LocalDate(e.date);
    } else if (key === "account") {
      return accountName(e.account_id, ctx);
    } else if (key === "institution") {
      return institutionName(e.account_id, ctx);
    } else if (key === "amount") {
      // Explicit so a zero amount stays a number. The generic tail below
      // falls back to `e.id` on any falsy value, and `Comparable.format`
      // discards a string/number pair — which would drop every
      // zero-amount manual row out of the amount ordering.
      return e.amount;
    } else {
      return e[key as keyof InvestmentTransaction] || e.id;
    }
  }

  const t = asTransaction(e, ctx);
  if (key === "date") {
    return new LocalDate(t.authorized_date || t.date);
  } else if (key === "merchant_name") {
    return t.merchant_name || t.name || "";
  } else if (key === "account") {
    return accountName(t.account_id, ctx);
  } else if (key === "institution") {
    return institutionName(t.account_id, ctx);
  } else if (key === "category") {
    return ctx.categories.get(e.label.category_id || "")?.name || "";
  } else if (key === "budget") {
    const account = ctx.accounts.get(t.account_id);
    const budget_id = e.label.budget_id || account?.label.budget_id;
    return ctx.budgets.get(budget_id || "")?.name || "";
  } else if (key === "location") {
    const { city, region, country } = t.location;
    return [city, region || country].filter((e) => e).join(", ");
  } else if (key === "amount") {
    return t.getRemainingAmount(ctx.transactionFamilies);
  } else {
    return t[key as keyof Transaction] || t.id;
  }
};

/**
 * The strings a row is searched against. Every row type the page mixes
 * contributes: an `InvestmentTransaction` through its own `name`, a
 * `SplitTransaction` through its parent's name / merchant name, plus —
 * for all three — the account, institution and label names the row's
 * account context resolves to. Some of those (budget, section,
 * category) are not rendered on every row type, so a query can re-rank
 * a row through text the user cannot see on it; that is pre-existing
 * for whole transactions and is kept uniform here rather than made
 * type-specific.
 */
export const getSearchPool = (e: TransactionRow, ctx: OrderingContext): string[] => {
  const searchPool: string[] = [];

  if (e instanceof InvestmentTransaction) {
    if (e.name) searchPool.push(e.name);
  } else {
    const t = asTransaction(e, ctx);
    if (t.name) searchPool.push(t.name);
    if (t.merchant_name) searchPool.push(t.merchant_name);
  }

  const account = ctx.accounts.get(e.account_id);
  if (account) {
    const { name, custom_name } = account;
    if (custom_name) searchPool.push(custom_name);
    else if (name) searchPool.push(name);
  }

  const institution_id = account?.institution_id;
  const institution = institution_id && ctx.institutions.get(institution_id);
  if (institution) searchPool.push(institution.name);

  const accountBudgetId = account?.label.budget_id;
  const { budget_id = accountBudgetId, category_id } = e.label;
  const budget = budget_id && ctx.budgets.get(budget_id);
  const category = category_id && ctx.categories.get(category_id);
  const section_id = category && category.section_id;
  const section = section_id && ctx.sections.get(section_id);

  if (budget) searchPool.push(budget.name);
  if (section) searchPool.push(section.name);
  if (category) searchPool.push(category.name);

  return searchPool;
};

/**
 * Deterministic base order, so the stable column sort layered on top
 * resolves ties the same way on every render. A split keys on its
 * parent's id, which is what keeps it adjacent to the parent it belongs
 * to; an investment row has no parent and keys on its own.
 */
const baseOrderKey = (e: TransactionRow): string =>
  e instanceof InvestmentTransaction ? e.id : e.transaction_id;

/**
 * The whole ordering tail of the transactions list: base order, then
 * the user's column sort, then the search re-rank. Shared by the
 * investment and cash branches of `filteredAndSorted`, so the header's
 * sort buttons and its `date descending` default order rows the same
 * way in both.
 */
export const orderRows = (
  rows: TransactionRow[],
  sortings: Sorter<TransactionHeaderSet>["sortings"],
  ctx: OrderingContext,
  hit: (searchValue: string, row: TransactionRow) => number,
  searchValue: string,
): TransactionRow[] => {
  const based = [...rows].sort((a, b) => {
    const keyA = baseOrderKey(a);
    const keyB = baseOrderKey(b);
    return keyA > keyB ? 1 : keyA === keyB ? 0 : -1;
  });

  const sorted = applySortings(based, sortings, (e, key) => formatSortValue(e, key, ctx));

  if (!searchValue) return sorted;

  return sorted.sort((a, b) => {
    const hitA = hit(searchValue, a);
    const hitB = hit(searchValue, b);
    if (hitA < hitB) return 1;
    if (hitA > hitB) return -1;
    return 0;
  });
};
