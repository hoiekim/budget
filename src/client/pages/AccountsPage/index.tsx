import { AccountType } from "plaid";
import { useEffect, useMemo, useRef, useState } from "react";
import { currencyCodeToSymbol } from "common";
import { colors, getAccountBalance, ScreenType, useAppContext, useDebounce } from "client";
import { AccountsDonut, AccountsTable, DonutData } from "client/components";
import "./index.css";

export const AccountsPage = () => {
  const { data, viewDate, screenType } = useAppContext();
  const { accounts } = data;

  const ref = useRef(null);
  const [donutRadius, setDonutRadius] = useState(80);
  const debouncer = useDebounce();

  useEffect(() => {
    const listener = () => {
      const newRadius = Math.max(80 - window.scrollY / 2, 20);
      setDonutRadius(newRadius);
    };

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

  return (
    <div className={classNames.join(" ")} ref={ref}>
      <h2>All&nbsp;Accounts</h2>
      <AccountsDonut
        balanceTotal={balanceTotal}
        currencySymbol={currencySymbol}
        donutData={donutData}
        radius={donutRadius}
      />
      <AccountsTable donutData={donutData} />
    </div>
  );
};
