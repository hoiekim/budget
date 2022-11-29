import { useMemo, useRef, useState } from "react";
import {
  currencyCodeToSymbol,
  numberToCommaString,
  call,
  useAppContext,
  PATH,
} from "client";
import { Budget, DeepPartial } from "server";
import { Bar, CapacityInput, EditButton, NameInput } from "../BudgetDetail/common";

interface Props {
  budget: Budget & { amount?: number };
}

// TODO: refactor for reusable components across BudgetBar and BudgetDetail
const BudgetBar = ({ budget }: Props) => {
  const { selectedInterval, setBudgets, transactions, accounts, viewDate, router } =
    useAppContext();
  const { budget_id, name, capacities, iso_currency_code, amount } = budget;
  const [isEditting, setIsEditting] = useState(!name);

  const onClickBudgetInfo = () => {
    const params = new URLSearchParams({ budget_id });
    router.go(PATH.BUDGET_DETAIL, { params });
  };

  const onDelete = async () => {
    if (!window.confirm(`Do you want to delete budget: ${name || "Unnamed"}?`)) return;
    const queryString = "?" + new URLSearchParams({ id: budget_id }).toString();
    const { status } = await call.delete("/api/budget" + queryString);
    if (status === "success") {
      setBudgets((oldBudgets) => {
        const newBudgets = new Map(oldBudgets);
        newBudgets.delete(budget_id);
        return newBudgets;
      });
    }
  };

  const capacity = capacities[selectedInterval] || 0;

  const unlabeledTotal = useMemo(() => {
    let result = 0;
    const viewDateClone = viewDate.clone();
    transactions.forEach((e) => {
      const { account_id, authorized_date, date, label, amount } = e;
      const transactionDate = new Date(authorized_date || date);
      if (!viewDateClone.has(transactionDate)) return;
      const account = accounts.get(account_id);
      if (!account || account.hide) return;
      const { category_id, budget_id: labelBudgetId } = label;
      if (category_id) return;
      if ((labelBudgetId || account.label.budget_id) !== budget_id) return;
      if (amount > 0) result += amount;
    });
    return result;
  }, [transactions, accounts, budget_id, viewDate]);

  const labeledRatio = (amount || 0) / capacity || 0;
  const unlabledRatio = unlabeledTotal / capacity || 0;

  type SetTimeout = typeof setTimeout;
  type Timeout = ReturnType<SetTimeout>;

  const timeout = useRef<Timeout>();

  const submit = (updatedBudget: DeepPartial<Budget> = {}, onError?: () => void) => {
    clearTimeout(timeout.current);
    timeout.current = setTimeout(async () => {
      try {
        const { status } = await call.post("/api/budget", {
          ...updatedBudget,
          budget_id,
        });
        if (status === "success") {
          setBudgets((oldBudgets) => {
            const newBudgets = new Map(oldBudgets);
            const oldBudget = oldBudgets.get(budget_id);
            const newBudget = { ...oldBudget, ...updatedBudget };
            newBudgets.set(budget_id, newBudget as Budget);
            return newBudgets;
          });
        } else throw new Error(`Failed to update budget: ${budget_id}`);
      } catch (error: any) {
        console.error(error);
        if (onError) onError();
      }
    }, 500);
  };

  return (
    <div
      className="BudgetBar budgetInfo"
      onMouseLeave={() => setIsEditting(false)}
      onClick={() => {
        setIsEditting(false);
        onClickBudgetInfo();
      }}
    >
      <div className="title">
        <NameInput
          defaultValue={name}
          isEditting={isEditting}
          submit={(value, onError) => {
            submit({ name: value }, onError);
          }}
        />
        <div className="buttons">
          <EditButton
            isEditting={isEditting}
            onEdit={() => setIsEditting((s) => !s)}
            onDelete={onDelete}
          />
        </div>
      </div>
      <div className="statusBarWithText">
        <Bar ratio={labeledRatio} unlabledRatio={unlabledRatio} />
        <div className="infoText">
          <div>
            <span>Spent {currencyCodeToSymbol(iso_currency_code)}&nbsp;</span>
            <span className="currentTotal">
              {numberToCommaString((amount || 0) + unlabeledTotal)}
            </span>
            <span>&nbsp;of {currencyCodeToSymbol(iso_currency_code)}&nbsp;</span>
            <CapacityInput
              key={`${budget_id}_${selectedInterval}`}
              defaultValue={numberToCommaString(capacity)}
              isEditting={isEditting}
              submit={(value, onError) => {
                submit({ capacities: { [selectedInterval]: +value } }, onError);
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default BudgetBar;
