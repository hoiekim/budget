import { AccountType } from "plaid";
import { useMemo } from "react";
import {
  Account,
  currencyCodeToSymbol,
  ItemProvider,
  numberToCommaString,
  toTitleCase,
  ViewDate,
} from "common";
import { PATH, ScreenType, useAccountGraph, useAppContext } from "client";
import {
  DateLabel,
  DynamicCapacityInput,
  Graph,
  InstitutionSpan,
  MoneyLabel,
  ToggleInput,
} from "client/components";
import { useAccountEventHandlers } from "./lib";
import "./index.css";

interface Props {
  account: Account;
}

export const AccountProperties = ({ account }: Props) => {
  const { account_id, balances, name, type, subtype } = account;
  const { available, current, iso_currency_code } = balances;
  const currencySymbol = currencyCodeToSymbol(iso_currency_code || "");

  const { graphViewDate, graphData, cursorAmount } = useAccountGraph([account]);

  const { data, viewDate, router, screenType } = useAppContext();
  const { budgets, items } = data;

  const {
    nameInput,
    onChangeNameInput,
    typeInput,
    onChangeTypeInput,
    selectedBudgetIdLabel,
    onChangeBudgetSelect,
    isHidden,
    onClickHide,
    useTransactionsForGraph,
    onClickUseTransactionsForGraph,
    useSnapshotsForGraph,
    onClickUseSnapshotsForGraph,
    balanceSnapshotInput,
    setBalanceSnapshotInput,
    onChangeBalanceSnapshotInput,
    onClickRemove,
  } = useAccountEventHandlers(account, cursorAmount);

  const item = items.get(account.item_id);
  const isManualAccount = item?.provider === ItemProvider.MANUAL;

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
    current && available ? current - available : ((current || available) as number),
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

  const onClickTransactions = () => {
    const params = new URLSearchParams();
    params.append("account_id", account_id);
    router.go(PATH.TRANSACTIONS, { params });
  };

  const onClickConnectionDetail = () => {
    if (!item) return;
    const params = new URLSearchParams();
    params.append("item_id", item.id);
    router.go(PATH.CONNECTION_DETAIL, { params });
  };

  const latestViewDate = new ViewDate(viewDate.getInterval());
  const isBalanceInputDisabled =
    !isManualAccount && viewDate.getEndDate() >= latestViewDate.getEndDate();

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
          {isManualAccount ? (
            <select value={typeInput} onChange={onChangeTypeInput}>
              {Object.values(AccountType).map((type) => (
                <option key={type} value={type}>
                  {toTitleCase(type)}
                </option>
              ))}
            </select>
          ) : (
            <span>{toTitleCase(subtype || type)}</span>
          )}
        </div>
        <div className="row keyValue">
          <span className="propertyName">Institution</span>
          {isManualAccount ? (
            <span>Manual</span>
          ) : (
            <InstitutionSpan institution_id={account.institution_id} />
          )}
        </div>
      </div>
      {(!isManualAccount || !!graphData.lines) && <div className="propertyLabel">Balance</div>}
      {!isManualAccount && (
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
      )}
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
              <div className="amount">
                <DynamicCapacityInput
                  disabled={isBalanceInputDisabled}
                  className={isBalanceInputDisabled ? "disabled" : ""}
                  value={balanceSnapshotInput}
                  setValue={setBalanceSnapshotInput}
                  prefix={currencySymbol}
                  fixed={2}
                  onBlur={onChangeBalanceSnapshotInput}
                />
              </div>
            </div>
          </div>
        </>
      )}
      {!isManualAccount && (
        <>
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
        </>
      )}

      <div className="propertyLabel">Navigate</div>
      <div className="property">
        <div className="row button">
          <button onClick={onClickConnectionDetail}>See&nbsp;Connection&nbsp;Details</button>
        </div>
        {screenType === ScreenType.Narrow && (
          <div className="row button">
            <button className="propertyName" onClick={onClickTransactions}>
              See&nbsp;Transactions
            </button>
          </div>
        )}
      </div>
      {isManualAccount && (
        <>
          <br />
          <div className="property">
            <div className="row button">
              <button className="delete colored" onClick={onClickRemove}>
                Delete
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
