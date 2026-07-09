import { AccountType } from "plaid";
import { useMemo } from "react";
import {
  currencyCodeToSymbol,
  ItemProvider,
  numberToCommaString,
  toTitleCase,
  ViewDate,
} from "common";
import {
  Account,
  PATH,
  ScreenType,
  useAccountGraph,
  useAppContext,
  useTransactionEntry,
} from "client";
import {
  DateLabel,
  DynamicCapacityInput,
  Graph,
  HoldingsComposition,
  KeyValue,
  PerformanceBenchmark,
  InstitutionSpan,
  MoneyLabel,
  Properties,
  Property,
  PropertyLabel,
  Row,
  ToggleInput,
} from "client/components";
import { useAccountEventHandlers } from "./lib";

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
    isArchived,
    onClickArchive,
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

  const { addTransaction, addInvestmentTransaction } = useTransactionEntry();
  const onClickAddTransaction = () => addTransaction({ account_id, iso_currency_code });

  /**
   * NOT gated on `isManualAccount` — the motivating case (#585) is
   * RSU/ESPP grants on a Plaid-connected brokerage that pre-date
   * Plaid's 24-mo transaction window. Server marks the row
   * `source='manual'` so it survives future Plaid syncs.
   */
  const onClickAddInvestmentTransaction = () => addInvestmentTransaction({ account_id });

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
    <Properties className="AccountProperties">
      <PropertyLabel>Account&nbsp;Details</PropertyLabel>
      <Property>
        <KeyValue name="Name">
          <input type="text" value={nameInput} onChange={onChangeNameInput} placeholder={name} />
        </KeyValue>
        <KeyValue name="Type">
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
        </KeyValue>
        <KeyValue name="Institution">
          {isManualAccount ? (
            <span>Manual</span>
          ) : (
            <InstitutionSpan institution_id={account.institution_id} />
          )}
        </KeyValue>
      </Property>
      {(!isManualAccount || !!graphData.lines) && <PropertyLabel>Balance</PropertyLabel>}
      {!isManualAccount && (
        <Property>
          <KeyValue name={currentLabel}>
            <span>
              {currencySymbol}&nbsp;
              {currentAmountString}
            </span>
          </KeyValue>
          <KeyValue name={pendingLabel}>
            <span>
              {currencySymbol}&nbsp;
              {pendingAmountString}
            </span>
          </KeyValue>
        </Property>
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
          <Property>
            <KeyValue name={<>{viewDate.toString()}&nbsp;balance</>}>
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
            </KeyValue>
          </Property>
        </>
      )}
      {type === AccountType.Investment && <HoldingsComposition accounts={[account]} />}
      {type === AccountType.Investment && <PerformanceBenchmark accounts={[account]} />}
      {!isManualAccount && (
        <>
          <PropertyLabel>Balance&nbsp;Graph&nbsp;Options</PropertyLabel>
          <Property>
            <KeyValue name="Use Transactions">
              <ToggleInput
                checked={useTransactionsForGraph}
                onChange={onClickUseTransactionsForGraph}
              />
            </KeyValue>
            <KeyValue name="Use Snapshots">
              <ToggleInput checked={useSnapshotsForGraph} onChange={onClickUseSnapshotsForGraph} />
            </KeyValue>
          </Property>
          <PropertyLabel>Account&nbsp;Preference</PropertyLabel>
          <Property>
            <KeyValue name="Default&nbsp;Budget">
              <select value={selectedBudgetIdLabel} onChange={onChangeBudgetSelect}>
                <option value="">Select Budget</option>
                {budgetOptions}
              </select>
            </KeyValue>
            <KeyValue name="Archive">
              {/* Hide already removes the account from view entirely; archiving
               *  on top adds nothing and would surface in "Show archived (N)"
               *  even though the user's already hidden the row. Disable to
               *  steer the user toward Unhide first if they want a different
               *  classification. Hoie 2026-06-25. */}
              <ToggleInput checked={isArchived} onChange={onClickArchive} disabled={isHidden} />
            </KeyValue>
            <KeyValue name="Hide">
              <ToggleInput checked={isHidden} onChange={onClickHide} />
            </KeyValue>
          </Property>
        </>
      )}
      {/* Orphan path: a manual account that was already archived (e.g. on
       *  an older client version where Archive was ungated, or via direct
       *  API). Without this, the user has no UI path back — Delete
       *  destroys history, which is the exact case `archived` was meant
       *  to avoid. Renders nothing for the common manual-and-not-archived
       *  case so we don't reintroduce a separate Archive section. */}
      {isManualAccount && isArchived && (
        <Property>
          <KeyValue name="Archive">
            <ToggleInput checked={isArchived} onChange={onClickArchive} />
          </KeyValue>
        </Property>
      )}
      {(isManualAccount || type === AccountType.Investment) && (
        <>
          <PropertyLabel>Add</PropertyLabel>
          <Property>
            {isManualAccount && type !== AccountType.Investment && (
              <Row className="button">
                <button onClick={onClickAddTransaction}>Add&nbsp;Transaction</button>
              </Row>
            )}
            {type === AccountType.Investment && (
              <Row className="button">
                <button onClick={onClickAddInvestmentTransaction}>
                  Add&nbsp;Investment&nbsp;Transaction
                </button>
              </Row>
            )}
          </Property>
        </>
      )}
      <PropertyLabel>Navigate</PropertyLabel>
      <Property>
        <Row className="button">
          <button onClick={onClickConnectionDetail}>See&nbsp;Connection&nbsp;Details</button>
        </Row>
        {screenType === ScreenType.Narrow && (
          <Row className="button">
            <button className="propertyName" onClick={onClickTransactions}>
              See&nbsp;Transactions
            </button>
          </Row>
        )}
      </Property>
      {isManualAccount && (
        <>
          <br />
          <Property>
            <Row className="button">
              <button className="delete colored" onClick={onClickRemove}>
                Delete
              </button>
            </Row>
          </Property>
        </>
      )}
    </Properties>
  );
};
