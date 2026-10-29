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
  DeleteButton,
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
  ButtonRow,
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
  const currencySymbol = currencyCodeToSymbol(iso_currency_code);

  const { graphViewDate, graphData, cursorAmount } = useAccountGraph([account]);

  const { data, viewDate, router, screenType, calculations } = useAppContext();
  const { budgets, items } = data;
  const { balanceData, holdingsValueData } = calculations;

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

  // The Balance block must answer the selected period, like the graph, the
  // holdings total, and the Accounts row beside it. `balanceData.get` is the
  // same recorded value the Accounts row uses (see `getDisplayBalance`); a
  // past period with no recorded balance keeps the live figures, as today.
  const viewEndDate = viewDate.getEndDate();
  const latestViewDate = new ViewDate(viewDate.getInterval());
  const isPastPeriod = viewEndDate < latestViewDate.getEndDate();
  const periodBalance = isPastPeriod ? balanceData.get(account_id, viewEndDate) : undefined;

  // View-date cash for investment accounts: the same per-holding history
  // HoldingsComposition sums for its Cash bucket, at the same view date,
  // so Invested + In Cash reconciles with that table by construction.
  // Unknown when no holding has a summary for the period — then the live
  // partition stays, rather than inventing a $0 cash figure.
  const periodCash = useMemo(() => {
    if (type !== AccountType.Investment || periodBalance === undefined) return undefined;
    const holdingIds = holdingsValueData.getHoldingsForAccount(account_id);
    let cash = 0;
    let hasData = false;
    for (const holdingId of holdingIds) {
      const summary = holdingsValueData.getHistory(holdingId).get(viewEndDate);
      if (!summary) continue;
      hasData = true;
      if (summary.isCash) cash += summary.value;
    }
    return hasData ? cash : undefined;
  }, [type, periodBalance, holdingsValueData, account_id, viewEndDate]);

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
  let currentAmountString = numberToCommaString(current as number);
  let pendingAmountString = numberToCommaString(
    current && available ? current - available : ((current || available) as number),
  );
  let showPendingRow = true;
  if (type === AccountType.Credit) {
    currentLabel = "Spent";
    pendingLabel = "Available";
    pendingAmountString = numberToCommaString(available as number);
    if (periodBalance !== undefined) {
      // Spent is the period balance. Available has no historical series,
      // so it is not shown on past periods rather than mixing a live
      // figure into a period block.
      currentAmountString = numberToCommaString(periodBalance);
      showPendingRow = false;
    }
  } else if (type === AccountType.Investment) {
    currentLabel = "Invested";
    pendingLabel = "In Cash";
    // `available` is already included in `current`, so "Invested" (the non-cash
    // portion) is current − available; rendering full `current` here while also
    // listing `available` as "In Cash" would present the cash twice.
    currentAmountString = numberToCommaString(
      current && available ? current - available : (current as number),
    );
    pendingAmountString = numberToCommaString(available as number);
    // No cash figure to partition off when Plaid reports no `available`.
    showPendingRow = available != null;
    if (periodBalance !== undefined && periodCash !== undefined) {
      currentAmountString = numberToCommaString(periodBalance - periodCash);
      pendingAmountString = numberToCommaString(periodCash);
      showPendingRow = true;
    }
  } else if (periodBalance !== undefined) {
    // Depository / loan: the period balance. Pending (current − available)
    // is a live-derived split with no historical series, so it is not
    // shown on past periods.
    currentAmountString = numberToCommaString(periodBalance);
    showPendingRow = false;
  }

  const onClickTransactions = () => {
    const params = new URLSearchParams();
    params.append("account_id", account_id);
    router.go(PATH.TRANSACTIONS, { params });
  };

  const { addTransaction, addInvestmentTransaction } = useTransactionEntry();
  const onClickAddTransaction = () => addTransaction({ account_id, iso_currency_code });

  /**
   * NOT gated on `isManualAccount` — the motivating case is
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

  const onClickSnapshots = () => {
    const params = new URLSearchParams();
    params.append("account_id", account_id);
    router.go(PATH.SNAPSHOTS, { params });
  };

  const onClickImportPlanStatement = () => {
    const params = new URLSearchParams();
    params.append("account_id", account_id);
    router.go(PATH.PLAN_STATEMENT_IMPORT, { params });
  };

  const isBalanceInputDisabled = !isManualAccount && !isPastPeriod;

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
      {(!isManualAccount || !!graphData.lines) && (
        <PropertyLabel>
          Balance{isPastPeriod && <>&nbsp;({viewDate.toString()})</>}
        </PropertyLabel>
      )}
      {!isManualAccount && (
        <Property>
          <KeyValue name={currentLabel}>
            <span>
              {currencySymbol}&nbsp;
              {currentAmountString}
            </span>
          </KeyValue>
          {showPendingRow && (
            <KeyValue name={pendingLabel}>
              <span>
                {currencySymbol}&nbsp;
                {pendingAmountString}
              </span>
            </KeyValue>
          )}
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
        </>
      )}
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
           *  even though the user's already hidden the row. Disable to steer
           *  the user toward Unhide first. */}
          <ToggleInput checked={isArchived} onChange={onClickArchive} disabled={isHidden} />
        </KeyValue>
        <KeyValue name="Hide">
          <ToggleInput checked={isHidden} onChange={onClickHide} />
        </KeyValue>
      </Property>
      {(isManualAccount || type === AccountType.Investment) && (
        <>
          <PropertyLabel>Add</PropertyLabel>
          <Property>
            {isManualAccount && type !== AccountType.Investment && (
              <ButtonRow onClick={onClickAddTransaction}>Add&nbsp;Transaction</ButtonRow>
            )}
            {type === AccountType.Investment && (
              <ButtonRow onClick={onClickAddInvestmentTransaction}>
                Add&nbsp;Investment&nbsp;Transaction
              </ButtonRow>
            )}
            {isManualAccount && type === AccountType.Investment && (
              <ButtonRow onClick={onClickImportPlanStatement}>
                Import&nbsp;Plan&nbsp;Statement
              </ButtonRow>
            )}
          </Property>
        </>
      )}
      <PropertyLabel>Navigate</PropertyLabel>
      <Property>
        <ButtonRow onClick={onClickConnectionDetail}>See&nbsp;Connection&nbsp;Details</ButtonRow>
        <ButtonRow onClick={onClickSnapshots}>Manage&nbsp;Snapshots</ButtonRow>
        {screenType === ScreenType.Narrow && (
          <ButtonRow onClick={onClickTransactions}>See&nbsp;Transactions</ButtonRow>
        )}
      </Property>
      {isManualAccount && (
        <>
          <br />
          <Property>
            <Row className="button">
              <DeleteButton
                confirmMessage="Do you want to delete this account?"
                onClick={onClickRemove}
              >
                Delete
              </DeleteButton>
            </Row>
          </Property>
        </>
      )}
    </Properties>
  );
};
