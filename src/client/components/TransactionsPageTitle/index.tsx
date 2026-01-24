import { ChevronDownIcon, ScreenType, Sorter, useAppContext } from "client";
import {
  Account,
  Budget,
  Category,
  InvestmentTransaction,
  Section,
  SplitTransaction,
  toTitleCase,
  Transaction,
} from "common";
import { useCallback, useEffect, useRef, useState } from "react";
import { TransactionsHead } from "./TransactionsHead";
import "./index.css";
import { SearchBar } from "./SearchBar";
import { AccountType } from "plaid";

export type TransactionsPageType = "deposits" | "expenses" | "unsorted";

interface TransactionsPageFilters {
  type?: TransactionsPageType;
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

enum TITLES {
  all = "All Transactions",
  unsorted = "Unsorted Transactions",
  deposits = "Deposits",
  expenses = "Expenses",
}

const typeToTitle = (type?: TransactionsPageType) => {
  if (type) return TITLES[type];
  return "All Transactions";
};

export type TransactionHeaders = { [k in keyof Transaction]?: boolean } & {
  account?: boolean;
  institution?: boolean;
  budget?: boolean;
};

export type InvestmentTransactionHeaders = { [k in keyof InvestmentTransaction]?: boolean } & {
  account?: boolean;
  institution?: boolean;
};

export const TransactionsPageTitle = ({
  filters,
  sorter,
  onChangeSearchValue,
}: TransactionsPageTitleProps) => {
  const { type: selectedType, account, budget, section, category } = filters;
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

  const options = [...Object.entries(TITLES)].map(([type, title]) => {
    const isSelected = type === (selectedType || "all");
    const onClickSelectOption = () => {
      setIsSelecting(false);
      const newParams = new URLSearchParams(params);
      if (type === "all") newParams.delete("transactions_type");
      else newParams.set("transactions_type", type as TransactionsPageType);
      go(path, { params: newParams, animate: false });
    };
    return (
      <button key={title} onClick={onClickSelectOption}>
        {isSelected && <span className="checkmark">✓</span>}
        <span>{title}</span>
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
    []
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
          <span>{typeToTitle(selectedType)}</span>
          <ChevronDownIcon size={15} />
        </button>
        {isSelecting && (
          <div ref={selectBoxRef} className="select" onMouseLeave={closeSelect}>
            <div className="selectLabel" onClick={closeSelect}>
              <span>Select&nbsp;transaction&nbsp;type</span>
              <button className="closeButton">✕</button>
            </div>
            <div className="options">{options}</div>
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
        sorter={sorter as any}
        getHeaderName={getHeader}
        headerKeys={headerKeys as any}
        style={{ top: transactionsHeadTop }}
      />
    </>
  );
};
