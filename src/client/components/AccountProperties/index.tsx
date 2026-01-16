import { AccountType } from "plaid";
import { useMemo } from "react";
import { Account, currencyCodeToSymbol, numberToCommaString, toTitleCase } from "common";
import { useAccountEventHandlers, useAccountGraph, useAppContext } from "client";
import { DateLabel, Graph, InstitutionSpan, MoneyLabel, ToggleInput } from "client/components";

interface Props {
  account: Account;
}

export const AccountProperties = ({ account }: Props) => {
  const { account_id, balances, name, type, subtype, graphOptions } = account;
  const { available, current, iso_currency_code } = balances;
  const currencySymbol = currencyCodeToSymbol(iso_currency_code || "");

  const { graphViewDate, graphData, cursorAmount } = useAccountGraph([account], graphOptions);

  const { data, viewDate } = useAppContext();
  const { budgets } = data;
  const {
    nameInput,
    onChangeNameInput,
    selectedBudgetIdLabel,
    onChangeBudgetSelect,
    isHidden,
    onClickHide,
    useTransactionsForGraph,
    onClickUseTransactionsForGraph,
    useSnapshotsForGraph,
    onClickUseSnapshotsForGraph,
  } = useAccountEventHandlers(account);

  const budgetOptions = useMemo(() => {
    const components: JSX.Element[] = [];
    budgets.forEach((e) => {
      const component = (
        <option key={`account_${account_id}_budget_option_${e.budget_id}`} value={e.budget_id}>
          {e.name}
        </option>
      );
      components.push(component);
    });
    return components;
  }, [account_id, budgets]);

  let currentLabel = "Current";
  let pendingLabel = "Pending";
  const currentAmountString = numberToCommaString(current as number);
  let pendingAmountString = numberToCommaString(
    current && available ? current - available : ((current || available) as number)
  );
  if (type === AccountType.Credit) {
    currentLabel = "Spent";
    pendingLabel = "Available";
    pendingAmountString = numberToCommaString(available as number);
  } else if (type === AccountType.Investment) {
    currentLabel = "Invested";
    pendingLabel = "In Cash";
    pendingAmountString = numberToCommaString(available as number);
  }

  return (
    <div className="AccountProperties Properties">
      <div className="propertyLabel">Account&nbsp;Details</div>
      <div className="property">
        <div className="row keyValue">
          <span className="propertyName">Name</span>
          <input type="text" value={nameInput} onChange={onChangeNameInput} placeholder={name} />
        </div>
        <div className="row keyValue">
          <span className="propertyName">Type</span>
          <span>{toTitleCase(subtype || type)}</span>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Institution</span>
          {account && <InstitutionSpan institution_id={account?.institution_id} />}
        </div>
      </div>
      <div className="propertyLabel">Balance</div>
      <div className="property">
        <div className="row keyValue">
          <span className="propertyName">{currentLabel}</span>
          <span>
            {currencySymbol}&nbsp;
            {currentAmountString}
          </span>
        </div>
        <div className="row keyValue">
          <span className="propertyName">{pendingLabel}</span>
          <span>
            {currencySymbol}&nbsp;
            {pendingAmountString}
          </span>
        </div>
      </div>
      {!!graphData.lines && (
        <>
          <br />
          <Graph
            input={graphData}
            labelX={new DateLabel(graphViewDate)}
            labelY={new MoneyLabel(currencySymbol)}
            memoryKey={account_id}
          />
          <br />
          <div className="property">
            <div className="row keyValue">
              <span className="propertyName">{viewDate.toString()}&nbsp;balance</span>
              <span>
                {currencySymbol}&nbsp;
                {cursorAmount !== undefined ? numberToCommaString(cursorAmount) : "0"}
              </span>
            </div>
          </div>
        </>
      )}
      <div className="propertyLabel">Balance&nbsp;Graph&nbsp;Options</div>
      <div className="property">
        <div className="row keyValue">
          <span className="propertyName">Use Transactions</span>
          <ToggleInput
            checked={useTransactionsForGraph}
            onChange={onClickUseTransactionsForGraph}
          />
        </div>
        <div className="row keyValue">
          <span className="propertyName">Use Snapshots</span>
          <ToggleInput checked={useSnapshotsForGraph} onChange={onClickUseSnapshotsForGraph} />
        </div>
      </div>
      <div className="propertyLabel">Account&nbsp;Preference</div>
      <div className="property">
        <div className="row keyValue">
          <span className="propertyName">Default&nbsp;Budget</span>
          <select value={selectedBudgetIdLabel} onChange={onChangeBudgetSelect}>
            <option value="">Select Budget</option>
            {budgetOptions}
          </select>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Hide</span>
          <ToggleInput checked={isHidden} onChange={onClickHide} />
        </div>
      </div>
    </div>
  );
};
