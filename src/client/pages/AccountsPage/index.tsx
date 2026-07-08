import { AccountType } from "plaid";
import { useEffect, useMemo, useState } from "react";
import { cap, currencyCodeToSymbol, ViewDate } from "common";
import {
  colors,
  getAccountBalance,
  getDisplayBalance,
  ScreenType,
  useAppContext,
  useDebounce,
  useMultiSelectQueryFilter,
} from "client";
import {
  AccountsDonut,
  AccountsTable,
  DonutData,
  FilterOption,
  PageFilterTitle,
} from "client/components";
import "./index.css";

const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  [AccountType.Depository]: "Depository",
  [AccountType.Credit]: "Credit",
  [AccountType.Investment]: "Investment",
  [AccountType.Loan]: "Loan",
  [AccountType.Brokerage]: "Brokerage",
  [AccountType.Other]: "Other",
};

const titleForSelection = (types: AccountType[]): string => {
  if (types.length === 0) return "All Accounts";
  if (types.length === 1) return ACCOUNT_TYPE_LABELS[types[0]];
  return types.map((t) => ACCOUNT_TYPE_LABELS[t]).join(", ");
};

export const AccountsPage = () => {
  const { data, calculations, viewDate, screenType } = useAppContext();
  const { balanceData } = calculations;
  const { accounts } = data;

  const {
    selected: selectedTypes,
    toggle,
    clearAll,
    options,
  } = useMultiSelectQueryFilter<AccountType>("account_type", ACCOUNT_TYPE_LABELS);

  const [scrollY, setScrollY] = useState(0);
  const debouncer = useDebounce();

  useEffect(() => {
    const listener = () => setScrollY(window.scrollY);
    window.addEventListener("scroll", listener);
    return () => window.removeEventListener("scroll", listener);
  }, [debouncer]);

  const { donutData, currencySymbol, balanceTotal, totalCredit, numberOfCredits } = useMemo(() => {
    let balanceTotal = 0;
    let totalCredit = 0;
    let numberOfCredits = 0;
    const donutData: DonutData[] = [];

    const sortedAccounts = accounts
      .toArray()
      .sort((a, b) => getAccountBalance(b) - getAccountBalance(a));

    // Exclude both `hide` (duplicate-data Plaid shadow) and `archived`
    // (user-marked-out-of-active-view, typically expired cards) from the
    // donut + credit-total. Both flags only affect FE visibility; the
    // calc layer iterates all non-deleted accounts regardless.
    //
    // When the user hasn't set an explicit type filter, the default view
    // continues to exclude Credit (which has its own summary tile). When
    // the filter IS set, honor it verbatim — including a "Credit" pick
    // which surfaces credit accounts in the donut + table for that
    // filtered view.
    const filteredAccounts = sortedAccounts.filter(({ hide, archived, type }) => {
      if (hide || archived) return false;
      if (selectedTypes.length === 0) return type !== AccountType.Credit;
      return selectedTypes.includes(type);
    });

    sortedAccounts.forEach(({ hide, archived, type, balances }) => {
      if (hide || archived || type !== AccountType.Credit) return;
      totalCredit += balances.current || 0;
      numberOfCredits++;
    });

    // For yearly view of the current (incomplete) year, viewDate.getEndDate()
    // returns Dec 31 which has no balance data yet. Cap the lookup to the
    // current month so the donut reflects actual accumulated balances.
    const endDate = viewDate.getEndDate();
    const today = new Date();
    const viewDateDate =
      viewDate.getInterval() === "year" && endDate > today
        ? new ViewDate("month").getEndDate()
        : endDate;

    filteredAccounts.forEach((a, i) => {
      // While the cold-load history is still streaming, fall back to the live
      // balance rather than $0 so the headline total doesn't flash a bogus
      // net-worth collapse (#510).
      const value = getDisplayBalance(balanceData, a, viewDateDate, today, data.status.isLoading);
      balanceTotal += value;
      const color = colors[i % colors.length];
      const label = a.custom_name || a.name || "Unnamed";
      donutData.push({ id: a.id, value, color, label });
    });

    const currencyCodes = new Set(
      filteredAccounts.map((a) => a.balances.iso_currency_code || "USD"),
    );
    const currencyCode = currencyCodes.values().next().value || "USD";
    const currencySymbol = currencyCodeToSymbol(currencyCode);

    return { donutData, currencySymbol, balanceTotal, totalCredit, numberOfCredits };
  }, [accounts, balanceData, viewDate, data.status.isLoading, selectedTypes]);

  const isNarrow = screenType === ScreenType.Narrow;

  const donutRadius = cap(80 - Math.floor(scrollY / 2), { min: 20, max: 80 });
  const donutTop = isNarrow && scrollY >= 0 ? 104 - cap(Math.floor(scrollY), { max: 0 }) : 0;
  const donutPosition = isNarrow && scrollY >= 0 ? "fixed" : "relative";

  const tablePaddingTop = isNarrow && scrollY >= 0 ? 184 : 0;

  const classNames = ["AccountsPage"];
  if (!isNarrow) classNames.push("wideScreen");

  return (
    <div className={classNames.join(" ")}>
      <PageFilterTitle
        label={titleForSelection(selectedTypes)}
        dropdownLabel={<>Select&nbsp;account&nbsp;types</>}
        closeAriaLabel="Close account type selector"
      >
        <FilterOption checked={selectedTypes.length === 0} onSelect={clearAll}>
          All&nbsp;Accounts
        </FilterOption>
        {options.map(({ value, label }) => (
          <FilterOption
            key={value}
            checked={selectedTypes.includes(value)}
            onSelect={() => toggle(value)}
          >
            {label}
          </FilterOption>
        ))}
      </PageFilterTitle>
      <AccountsDonut
        balanceTotal={balanceTotal}
        currencySymbol={currencySymbol}
        donutData={donutData}
        totalCredit={totalCredit}
        numberOfCredits={numberOfCredits}
        radius={donutRadius}
        style={{ top: donutTop, position: donutPosition }}
      />
      <AccountsTable
        donutData={donutData}
        selectedTypes={selectedTypes}
        style={{ paddingTop: tablePaddingTop }}
      />
    </div>
  );
};
