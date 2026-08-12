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
} from "client";
import type { InvestmentTransactionHeaders, TransactionHeaders } from "client/components";
import { LocalDate } from "common";

export type TransactionRow = Transaction | SplitTransaction | InvestmentTransaction;
export type TransactionSortKey = keyof (TransactionHeaders & InvestmentTransactionHeaders);

/**
 * Lookup tables the ordering pipeline resolves a row's display values
 * against. Column sorting and search scoring both rank rows by what the
 * row *renders* (the account's custom name, the budget's name) rather
 * than by the foreign key it stores, so both need the same dictionaries.
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

const accountName = (account_id: string, ctx: OrderingContext): string => {
  const account = ctx.accounts.get(account_id);
  return account?.custom_name || account?.name || "";
};

const institutionName = (account_id: string, ctx: OrderingContext): string => {
  const account = ctx.accounts.get(account_id);
  return ctx.institutions.get(account?.institution_id || "")?.name || "";
};

/**
 * Resolve the value a row sorts by for a given column header. Shared by
 * both branches of `filteredAndSorted` — the investment view and the
 * cash view render different header sets but the same three columns
 * (`date` / `amount` / `account`) overlap, and they must order rows the
 * same way in both.
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

  const t = e.toTransaction();
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
 * The strings a row is searched against — the same text the row renders,
 * so a query that matches what the user can see ranks that row up.
 *
 * Every row type the page mixes contributes: an `InvestmentTransaction`
 * through its own `name`, a `SplitTransaction` through its parent's
 * name / merchant name plus its own label. Before #676 only whole
 * `Transaction`s filled the pool, so investment rows and splits scored
 * zero for every query and sank to the bottom of every search.
 */
export const getSearchPool = (e: TransactionRow, ctx: OrderingContext): string[] => {
  const searchPool: string[] = [];

  if (e instanceof InvestmentTransaction) {
    if (e.name) searchPool.push(e.name);
  } else if (e instanceof SplitTransaction) {
    // A split renders under its parent's name; `transaction_id` is the
    // parent's id. Resolved off the context dictionary rather than
    // `toTransaction()` so a split orphaned mid-render scores zero
    // instead of throwing on the parent's non-null assertion.
    const parent = ctx.transactions.get(e.transaction_id);
    if (parent?.name) searchPool.push(parent.name);
    if (parent?.merchant_name) searchPool.push(parent.merchant_name);
  } else {
    if (e.name) searchPool.push(e.name);
    if (e.merchant_name) searchPool.push(e.merchant_name);
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
