import { useCallback, useMemo } from "react";
import { InvestmentTransaction } from "common";
import { useAppContext, useSorter } from "client";
import InvestmentTransactionRow from "./InvestmentTransactionRow";
import InvestmentTransactionsHead from "./InvestmentTransactionsHead";
import "./index.css";

export type InvestmentTransactionHeaders = { [k in keyof InvestmentTransaction]?: boolean } & {
  account?: boolean;
  institution?: boolean;
};

interface Props {
  transactionsArray: InvestmentTransaction[];
  sorterKey?: string;
  top?: number;
}

export const InvestmentTransactionsTable = ({ transactionsArray, sorterKey, top }: Props) => {
  const { data } = useAppContext();
  const { accounts, institutions } = data;

  const sorter = useSorter<InvestmentTransaction, InvestmentTransactionHeaders>(
    "investment_transactions" + (sorterKey ? `_${sorterKey}` : ""),
    new Map([["date", "descending"]])
  );

  const { sort } = sorter;

  const sortedTransactionsArray = useMemo(() => {
    return sort([...transactionsArray], (t, key) => {
      if (key === "date") {
        return new Date(t.date);
      } else if (key === "account") {
        const account = accounts.get(t.account_id);
        return account?.custom_name || account?.name || "";
      } else if (key === "institution") {
        const account = accounts.get(t.account_id);
        return institutions.get(account?.institution_id || "")?.name || "";
      } else {
        return t[key];
      }
    });
  }, [transactionsArray, accounts, institutions, sort]);

  const transactionRows = sortedTransactionsArray.map((e) => {
    return <InvestmentTransactionRow key={e.id} investmentTransaction={e} />;
  });

  const getHeader = useCallback((key: keyof InvestmentTransactionHeaders): string => {
    if (key === "date") {
      return "Date";
    } else if (key === "amount") {
      return "Amount";
    } else if (key === "account") {
      return "Account";
    } else if (key === "institution") {
      return "Institution";
    } else {
      return key;
    }
  }, []);

  return (
    <div className="TransactionsTable">
      <div>
        <InvestmentTransactionsHead sorter={sorter} getHeader={getHeader} style={{ top }} />
        <div>{transactionRows}</div>
      </div>
    </div>
  );
};
