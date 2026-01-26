import { useMemo } from "react";
import { colors, useAppContext } from "client";
import { AccountsDonut, AccountsTable, DonutData } from "client/components";
import { currencyCodeToSymbol } from "common";
import "./index.css";
import { AccountSubtype, AccountType } from "plaid";

export const AccountsPage = () => {
  const { data } = useAppContext();
  const { accounts } = data;

  const { donutData, currencySymbol, balanceTotal } = useMemo(() => {
    let balanceTotal = 0;
    const donutData: DonutData[] = [];

    const filteredAccounts = accounts
      .toArray()
      .sort((a, b) => (b.balances.current || 0) - (a.balances.current || 0))
      .filter(({ hide, type, balances }) => {
        return !hide && type !== AccountType.Credit && (balances.current || balances.available);
      });

    filteredAccounts.forEach((a, i) => {
      const balanceCurrent = a.balances.current || 0;
      const balanceAvailalbe = a.balances.available || 0;
      let value = 0;
      if (a.type === AccountType.Investment) {
        if (a.subtype === AccountSubtype.CryptoExchange) value = balanceCurrent;
        else value = balanceCurrent + balanceAvailalbe;
      } else {
        value = balanceCurrent;
      }
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
  }, [accounts]);

  return (
    <div className="AccountsPage">
      <h2>All Accounts</h2>
      <AccountsDonut
        balanceTotal={balanceTotal}
        currencySymbol={currencySymbol}
        donutData={donutData}
      />
      <AccountsTable donutData={donutData} />
    </div>
  );
};
