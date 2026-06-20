import { AccountType } from "plaid";
import { KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { JSONInvestmentTransaction, JSONTransaction, toTitleCase } from "common";
import {
  Account,
  Budget,
  Category,
  InvestmentTransaction,
  Section,
  SplitTransaction,
  Transaction,
  ChevronDownIcon,
  ScreenType,
  Sorter,
  useAppContext,
} from "client";
import { TransactionsHead } from "./TransactionsHead";
import "./index.css";
import { SearchBar } from "./SearchBar";

export type TransactionsPageType =
  | "deposits"
  | "expenses"
  | "unsorted"
  | "suggested"
  | "transfers";

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
  unsorted: "Unsorted Transactions",
  suggested: "Suggested Transactions",
  deposits: "Deposits",
  expenses: "Expenses",
  transfers: "Transfers",
};

const VALID_TYPES = Object.keys(TYPE_LABELS) as TransactionsPageType[];

/**
 * Parse the `transactions_type` URL param. Stored as a comma-separated
 * list so multiple filters compose in the same param slot. Returns
 * the validated, deduplicated subset (unknown values dropped, first
 * occurrence wins on duplicates, original order preserved).
 */
export const parseTransactionsTypes = (raw: string | null): TransactionsPageType[] => {
  if (!raw) return [];
  const present = new Set(raw.split(",").map((p) => p.trim()));
  // Canonicalize to VALID_TYPES order (matching writeTypes) so a reversed or
  // duplicated URL param yields the same sort-preference key as the in-app
  // toggle — `?transactions_type=expenses,deposits` and `deposits,expenses`
  // must not store divergent sort keys.
  return VALID_TYPES.filter((v) => present.has(v));
};

const serializeTransactionsTypes = (types: TransactionsPageType[]): string => types.join(",");

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
  const { router, screenType } = useAppContext();
  const { go, path, params } = router;

  const [isSelecting, setIsSelecting] = useState(false);

  const selectBoxRef = useRef<HTMLDivElement>(null);

  const onClickSelect = () => setIsSelecting((v) => !v);
  const closeSelect = () => setIsSelecting(false);

  useEffect(() => {
    const handleTouchOutside: EventListener = (event) => {
      const node = event.target as Node;
      const { current } = selectBoxRef;
      if (current && !current.contains(node)) closeSelect();
    };
    document.addEventListener("touchstart", handleTouchOutside);
    return () => document.removeEventListener("touchstart", handleTouchOutside);
  }, []);

  const writeTypes = (next: TransactionsPageType[]) => {
    const newParams = new URLSearchParams(params);
    if (next.length === 0) newParams.delete("transactions_type");
    else newParams.set("transactions_type", serializeTransactionsTypes(next));
    go(path, { params: newParams, animate: false });
  };

  // "All Transactions" is the empty-selection sentinel: clicking it
  // clears every filter, regardless of which were on. Order of the
  // menu is fixed (alphabetical-ish by intent: status, sign, kind).
  const onClickAll = () => writeTypes([]);
  const toggleType = (t: TransactionsPageType) => {
    const set = new Set(selectedTypes);
    if (set.has(t)) set.delete(t);
    else set.add(t);
    // Preserve VALID_TYPES order so the URL is canonical regardless
    // of click sequence.
    writeTypes(VALID_TYPES.filter((v) => set.has(v)));
  };

  // Each row shows a checkbox indicating its current state — multi-choice
  // semantics so the user can see at a glance which filters are active.
  // "All Transactions" is the clear-all sentinel; its checkbox reflects
  // "no other filter selected" (i.e. you're viewing everything).
  const renderCheckbox = (checked: boolean) => (
    <span className={"checkbox" + (checked ? " checked" : "")} aria-hidden="true" />
  );

  const allButton = (
    <button key="__all" onClick={onClickAll}>
      {renderCheckbox(selectedTypes.length === 0)}
      <span>All Transactions</span>
    </button>
  );

  const typeButtons = VALID_TYPES.map((t) => {
    const isSelected = selectedTypes.includes(t);
    return (
      <button key={t} onClick={() => toggleType(t)}>
        {renderCheckbox(isSelected)}
        <span>{TYPE_LABELS[t]}</span>
      </button>
    );
  });

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
      <h2 className="heading">
        <button onClick={onClickSelect}>
          <span>{titleForSelection(selectedTypes)}</span>
          <ChevronDownIcon size={15} />
        </button>
        {isSelecting && (
          <div ref={selectBoxRef} className="select" onMouseLeave={closeSelect}>
            <div
              className="selectLabel"
              onClick={closeSelect}
              onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
                if (e.key === "Enter" || e.key === " " || e.key === "Escape") {
                  e.preventDefault();
                  closeSelect();
                }
              }}
              role="button"
              tabIndex={0}
              aria-label="Close transaction type selector"
            >
              <span>Select&nbsp;transaction&nbsp;types</span>
              <button className="closeButton" aria-hidden="true">✕</button>
            </div>
            <div className="options">
              {allButton}
              {typeButtons}
            </div>
          </div>
        )}
      </h2>
      {!!subtitle && (
        <h3 className="heading">
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
