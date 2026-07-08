import { AccountType } from "plaid";
import { useCallback } from "react";
import { JSONInvestmentTransaction, JSONTransaction, toTitleCase } from "common";
import {
  Account,
  Budget,
  Category,
  InvestmentTransaction,
  Section,
  SplitTransaction,
  Transaction,
  ScreenType,
  Sorter,
  useAppContext,
  useMultiSelectQueryFilter,
} from "client";
import { FilterOption, PageFilterTitle } from "client/components";
import { TransactionsHead } from "./TransactionsHead";
import "./index.css";
import { SearchBar } from "./SearchBar";

export type TransactionsPageType =
  | "deposits"
  | "expenses"
  | "unsorted"
  | "suggested"
  | "transfers"
  | "manual";

interface TransactionsPageFilters {
  types: TransactionsPageType[];
  account?: Account;
  budget?: Budget;
  section?: Section;
  category?: Category;
}

interface TransactionsPageTitleProps {
  filters: TransactionsPageFilters;
  sorter: Sorter<
    Transaction | InvestmentTransaction | SplitTransaction,
    TransactionHeaders & InvestmentTransactionHeaders
  >;
  onChangeSearchValue: (v: string) => void;
}

const TYPE_LABELS: Record<TransactionsPageType, string> = {
  unsorted: "Unsorted",
  suggested: "Suggested",
  deposits: "Deposits",
  expenses: "Expenses",
  transfers: "Transfers",
  manual: "Manual",
};

const VALID_TYPES = Object.keys(TYPE_LABELS) as TransactionsPageType[];

/**
 * Parse the `transactions_type` URL param. Stored as a comma-separated
 * list so multiple filters compose in the same param slot. Returns the
 * validated, deduplicated subset in canonical (VALID_TYPES) order so a
 * reversed or duplicated URL yields the same sort-preference key as the
 * in-app toggle — `?transactions_type=expenses,deposits` and
 * `deposits,expenses` must not store divergent sort keys.
 *
 * Kept for `TransactionsPage`'s transition-aware read (`activeParams`
 * may be `incomingParams` during narrow-screen route transitions off
 * `/transactions`, which the URL-first hook can't see).
 */
export const parseTransactionsTypes = (raw: string | null): TransactionsPageType[] => {
  if (!raw) return [];
  const present = new Set(raw.split(",").map((p) => p.trim()));
  return VALID_TYPES.filter((v) => present.has(v));
};

const titleForSelection = (types: TransactionsPageType[]): string => {
  if (types.length === 0) return "All Transactions";
  if (types.length === 1) return TYPE_LABELS[types[0]];
  return types.map((t) => TYPE_LABELS[t]).join(", ");
};

export type TransactionHeaders = { [k in keyof JSONTransaction]?: boolean } & {
  account?: boolean;
  institution?: boolean;
  budget?: boolean;
};

export type InvestmentTransactionHeaders = { [k in keyof JSONInvestmentTransaction]?: boolean } & {
  account?: boolean;
  institution?: boolean;
};

export const TransactionsPageTitle = ({
  filters,
  sorter,
  onChangeSearchValue,
}: TransactionsPageTitleProps) => {
  const { types: selectedTypes, account, budget, section, category } = filters;
  const { screenType } = useAppContext();
  const { toggle, clearAll } = useMultiSelectQueryFilter("transactions_type", VALID_TYPES);

  const accountName = account?.custom_name || account?.name;
  const budgetName = budget?.name;
  const sectionName = section?.name;
  const categoryName = category?.name;
  const subtitle = [accountName, categoryName, sectionName, budgetName].find(Boolean);

  const getHeader = useCallback(
    (key: keyof TransactionHeaders | keyof InvestmentTransactionHeaders): string => {
      if (key === "date") {
        return "Date";
      } else if (key === "merchant_name") {
        return "Name";
      } else if (key === "amount") {
        return "Amount";
      } else if (key === "account") {
        return "Account";
      } else if (key === "institution") {
        return "Institution";
      } else if (key === "budget") {
        return "Budget";
      } else if (key === "category") {
        return "Category";
      } else if (key === "location") {
        return "Location";
      } else {
        return key;
      }
    },
    [],
  );

  const isInvestment = account?.type === AccountType.Investment;
  const headerKeys = isInvestment
    ? ["date", "amount", "account"]
    : ["date", "merchant_name", "amount", "account", "budget", "category"];

  let transactionsHeadTop = subtitle ? 137 : 104;
  if (screenType !== ScreenType.Narrow) transactionsHeadTop -= 50;

  return (
    <>
      <PageFilterTitle
        className="TransactionsFilterTitle"
        label={titleForSelection(selectedTypes)}
        dropdownLabel={<>Select&nbsp;transaction&nbsp;types</>}
        closeAriaLabel="Close transaction type selector"
      >
        <FilterOption checked={selectedTypes.length === 0} onSelect={clearAll}>
          All Transactions
        </FilterOption>
        {VALID_TYPES.map((t) => (
          <FilterOption key={t} checked={selectedTypes.includes(t)} onSelect={() => toggle(t)}>
            {TYPE_LABELS[t]}
          </FilterOption>
        ))}
      </PageFilterTitle>
      {!!subtitle && (
        <h3>
          <span>{toTitleCase(subtitle)}</span>
        </h3>
      )}
      <SearchBar onChange={onChangeSearchValue} style={{ top: transactionsHeadTop }} />
      <TransactionsHead
        sorter={sorter}
        getHeaderName={getHeader}
        headerKeys={headerKeys as (keyof TransactionHeaders | keyof InvestmentTransactionHeaders)[]}
        style={{ top: transactionsHeadTop }}
      />
    </>
  );
};
