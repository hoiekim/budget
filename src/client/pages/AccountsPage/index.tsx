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
} from "client";
import { AccountsDonut, AccountsTable, DonutData } from "client/components";
import "./index.css";

export const AccountsPage = () => {
  const { data, calculations, viewDate, screenType } = useAppContext();
  const { balanceData } = calculations;
  const { accounts } = data;

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
    const filteredAccounts = sortedAccounts.filter(({ hide, archived, type }) => {
      return !hide && !archived && type !== AccountType.Credit;
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
  }, [accounts, balanceData, viewDate, data.status.isLoading]);

  const isNarrow = screenType === ScreenType.Narrow;

  const donutRadius = cap(80 - Math.floor(scrollY / 2), { min: 20, max: 80 });
  const donutTop = isNarrow && scrollY >= 0 ? 104 - cap(Math.floor(scrollY), { max: 0 }) : 0;
  const donutPosition = isNarrow && scrollY >= 0 ? "fixed" : "relative";

  const tablePaddingTop = isNarrow && scrollY >= 0 ? 184 : 0;

  const classNames = ["AccountsPage"];
  if (!isNarrow) classNames.push("wideScreen");

  return (
    <div className={classNames.join(" ")}>
      <h2>All&nbsp;Accounts</h2>
      <AccountsDonut
        balanceTotal={balanceTotal}
        currencySymbol={currencySymbol}
        donutData={donutData}
        totalCredit={totalCredit}
        numberOfCredits={numberOfCredits}
        radius={donutRadius}
        style={{ top: donutTop, position: donutPosition }}
      />
      <AccountsTable donutData={donutData} style={{ paddingTop: tablePaddingTop }} />
    </div>
  );
};
