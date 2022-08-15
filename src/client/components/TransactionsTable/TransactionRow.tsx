import { useState, ChangeEventHandler, useMemo } from "react";
import { Transaction } from "server";
import { useAppContext, call, Sorter, numberToCommaString } from "client";
import { InstitutionSpan } from "client/components";
import { TransactionHeaders } from ".";

interface Props {
  transaction: Transaction;
  sorter: Sorter<Transaction, TransactionHeaders>;
}

const TransactionRow = ({ transaction, sorter }: Props) => {
  const {
    transaction_id,
    account_id,
    authorized_date,
    date,
    merchant_name,
    name,
    amount,
    labels,
  } = transaction;

  const { getVisible } = sorter;

  const { setTransactions, accounts, sections, categories, selectedBudgetId } =
    useAppContext();

  const [selectedCategoryId, setSelectedCategoryId] = useState(() => {
    return labels.find((e) => e.budget_id === selectedBudgetId)?.category_id || "";
  });

  const categoryOptions = useMemo(() => {
    return Array.from(sections.values())
      .flatMap((e) => {
        if (e.budget_id !== selectedBudgetId) return [];
        return Array.from(categories.values()).filter(
          (f) => f.section_id === e.section_id
        );
      })
      .map((e) => {
        return (
          <option
            key={`transaction_${transaction_id}_category_option_${e.category_id}`}
            value={e.category_id}
          >
            {e.name}
          </option>
        );
      });
  }, [transaction_id, sections, categories, selectedBudgetId]);

  const account = accounts.get(account_id);
  const institution_id = account?.institution_id;

  const onChangeCategorySelect: ChangeEventHandler<HTMLSelectElement> = async (e) => {
    const { value } = e.target;
    if (!value) return;

    setSelectedCategoryId(value);

    const newLabel = { budget_id: selectedBudgetId, category_id: value };

    const r = await call.post("/api/transaction-label", {
      transaction_id,
      label: newLabel,
    });

    if (r.status === "success") {
      setTransactions((oldTransactions) => {
        const newTransactions = new Map(oldTransactions);
        const newTransaction = { ...transaction };
        const existingLabel = newTransaction.labels.find((e) => {
          if (e.budget_id === selectedBudgetId) {
            e.category_id = value;
            return true;
          }
          return false;
        });
        if (!existingLabel) newTransaction.labels.push(newLabel);
        newTransactions.set(transaction_id, newTransaction);
        return newTransactions;
      });
    } else {
      setSelectedCategoryId(selectedCategoryId);
    }
  };

  return (
    <tr>
      {getVisible("authorized_date") && (
        <td>
          <div>
            {new Date(authorized_date || date).toLocaleString("en-US", {
              year: "numeric",
              month: "numeric",
              day: "numeric",
            })}
          </div>
        </td>
      )}
      {getVisible("merchant_name") && (
        <td>
          <div>{merchant_name || name}</div>
        </td>
      )}
      {getVisible("amount") && (
        <td>
          <div>{numberToCommaString(-amount)}</div>
        </td>
      )}
      {getVisible("account") && (
        <td>
          <div>{account?.name}</div>
        </td>
      )}
      {getVisible("institution") && (
        <td>
          <div>
            <InstitutionSpan institution_id={institution_id} />
          </div>
        </td>
      )}
      {getVisible("category") && (
        <td>
          <div>
            <select value={selectedCategoryId} onChange={onChangeCategorySelect}>
              <option value="">Select Category</option>
              {categoryOptions}
            </select>
          </div>
        </td>
      )}
    </tr>
  );
};

export default TransactionRow;
