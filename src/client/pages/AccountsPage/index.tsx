import { AccountType } from "plaid";
import { useEffect, useMemo, useRef, useState } from "react";
import { currencyCodeToSymbol } from "common";
import { colors, getAccountBalance, useAppContext } from "client";
import { AccountsDonut, AccountsTable, DonutData } from "client/components";
import "./index.css";

export const AccountsPage = () => {
  const { data, viewDate } = useAppContext();
  const { accounts } = data;

  const sentinelRef = useRef(null);
  const [isDonutShrunk, setIsDonutShrunk] = useState(false);

  useEffect(() => {
    const listener: IntersectionObserverCallback = ([entry]) => {
      setIsDonutShrunk(!entry.isIntersecting);
    };

    const observer = new IntersectionObserver(listener, { threshold: [1.0] });
    if (sentinelRef.current) observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, []);

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

  return (
    <div className="AccountsPage">
      <div
        ref={sentinelRef}
        className="sentinel"
        style={{ position: "absolute", top: "0", height: "1px", width: "1px" }}
      />
      <h2>All&nbsp;Accounts</h2>
      <AccountsDonut
        balanceTotal={balanceTotal}
        currencySymbol={currencySymbol}
        donutData={donutData}
        isShrunk={isDonutShrunk}
      />
      <AccountsTable donutData={donutData} />
    </div>
  );
};
