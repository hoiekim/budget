import { useState, useEffect, useMemo } from "react";
import { Account } from "common";
import { useAppContext, DateLabel, MoneyLabel } from "client";
import { InstitutionSpan, PlaidLinkButton, Graph } from "client/components";
import "./index.css";
import { useEventHandlers, useGraph } from "./lib";
import Balance from "./Balance";

interface Props {
  account: Account;
}

const AccountRow = ({ account }: Props) => {
  const { account_id, balances, custom_name, name, institution_id, label, type } =
    account;

  const { items, budgets, viewDate } = useAppContext();

  const [selectedBudgetIdLabel, setSelectedBudgetIdLabel] = useState(() => {
    return label.budget_id || "";
  });
  const [nameInput, setNameInput] = useState(custom_name || name);

  useEffect(() => {
    setNameInput(custom_name || name);
  }, [custom_name, name, setNameInput]);

  const budgetOptions = useMemo(() => {
    const components: JSX.Element[] = [];
    budgets.forEach((e) => {
      const component = (
        <option
          key={`account_${account_id}_budget_option_${e.budget_id}`}
          value={e.budget_id}
        >
          {e.name}
        </option>
      );
      components.push(component);
    });
    return components;
  }, [account_id, budgets]);

  const item = items.get(account.item_id);

  const { iso_currency_code, unofficial_currency_code } = balances;
  const currencyCode = iso_currency_code || unofficial_currency_code || "USD";

  const { graphViewDate, graphData } = useGraph(account, viewDate);

  const {
    onClickAccount,
    onChangeNameInput,
    onChangeBudgetSelect,
    onClickRemove,
    onClickHide,
  } = useEventHandlers(
    account,
    selectedBudgetIdLabel,
    setSelectedBudgetIdLabel,
    setNameInput
  );

  return (
    <div className="AccountRow" onClick={onClickAccount}>
      <div>
        <input
          onClick={(e) => e.stopPropagation()}
          onChange={onChangeNameInput}
          value={nameInput}
        />
      </div>
      <div>
        <InstitutionSpan institution_id={institution_id} />
      </div>
      <Balance balances={balances} type={type} />
      {!!graphData.lines && (
        <Graph
          data={graphData}
          labelX={new DateLabel(graphViewDate)}
          labelY={new MoneyLabel(currencyCode)}
          memoryKey={account_id}
        />
      )}
      <div className="budgetAction">
        <div>
          <select
            value={selectedBudgetIdLabel}
            onClick={(e) => e.stopPropagation()}
            onChange={onChangeBudgetSelect}
          >
            <option value="">Select Budget</option>
            {budgetOptions}
          </select>
        </div>
        <div className="action">
          <PlaidLinkButton item={item}>Update</PlaidLinkButton>
          <button onClick={onClickRemove}>Remove</button>
          <button onClick={onClickHide}>Hide</button>
        </div>
      </div>
    </div>
  );
};

export default AccountRow;
