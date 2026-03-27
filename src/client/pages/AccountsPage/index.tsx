import { AccountType } from "plaid";
import { useEffect, useMemo, useState } from "react";
import { cap, currencyCodeToSymbol, ViewDate } from "common";
import { colors, getAccountBalance, ScreenType, useAppContext, useDebounce } from "client";
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

  const { donutData, currencySymbol, balanceTotal } = useMemo(() => {
    let balanceTotal = 0;
    const donutData: DonutData[] = [];

    const filteredAccounts = accounts
      .toArray()
      .sort((a, b) => getAccountBalance(b) - getAccountBalance(a))
      .filter(({ hide, type, balances }) => {
        return !hide && type !== AccountType.Credit && (balances.current || balances.available);
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
      const balanceHistory = balanceData.get(a.id);
      const fallback = viewDateDate > today ? getAccountBalance(a) : 0;
      const value = balanceHistory.get(viewDateDate) || fallback;
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

    return { donutData, currencySymbol, balanceTotal };
  }, [accounts, balanceData, viewDate]);

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
        radius={donutRadius}
        style={{ top: donutTop, position: donutPosition }}
      />
      <AccountsTable donutData={donutData} style={{ paddingTop: tablePaddingTop }} />
    </div>
  );
};
