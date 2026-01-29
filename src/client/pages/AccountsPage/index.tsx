import { AccountType } from "plaid";
import { useEffect, useMemo, useState } from "react";
import { currencyCodeToSymbol } from "common";
import { colors, getAccountBalance, ScreenType, useAppContext, useDebounce } from "client";
import { AccountsDonut, AccountsTable, DonutData } from "client/components";
import "./index.css";

export const AccountsPage = () => {
  const { data, viewDate, screenType } = useAppContext();
  const { accounts } = data;

  const [windowScrollY, setWindowScrollY] = useState(0);
  const debouncer = useDebounce();

  useEffect(() => {
    const listener = () => setWindowScrollY(window.scrollY);
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

    const viewDateSpan = Math.max(-viewDate.getSpanFrom(new Date()), 0);

    filteredAccounts.forEach((a, i) => {
      const value = a.balanceHistory?.[viewDateSpan] || 0;
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
  }, [accounts, viewDate]);
  const classNames = ["AccountsPage"];
  if (screenType !== ScreenType.Narrow) classNames.push("wideScreen");

  const donutRadius = Math.floor(Math.min(Math.max(80 - windowScrollY / 2, 20), 80));
  const donutTop = screenType === ScreenType.Narrow ? 104 - Math.min(windowScrollY, 0) : undefined;

  return (
    <div className={classNames.join(" ")}>
      <h2>All&nbsp;Accounts</h2>
      <AccountsDonut
        balanceTotal={balanceTotal}
        currencySymbol={currencySymbol}
        donutData={donutData}
        radius={donutRadius}
        style={{ top: donutTop }}
      />
      <AccountsTable donutData={donutData} />
    </div>
  );
};
