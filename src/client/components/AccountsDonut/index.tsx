import { Donut, colors, useAppContext } from "client";
import { currencyCodeToSymbol, numberToCommaString } from "common";
import { DonutData } from "client/components";
import BalanceBreakDown from "./BalanceBreakDown";
import "./index.css";
import { AccountType } from "plaid";

const LABEL_UNNAMED = "Unnamed";

const AccountsDonut = () => {
  const { data } = useAppContext();
  const { accounts } = data;

  let balanceTotal = 0;
  const accountsDonutData: DonutData[] = [];

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
    if (a.type === AccountType.Investment) value = balanceCurrent + balanceAvailalbe;
    else value = balanceCurrent;
    balanceTotal += value;
    const color = colors[i % colors.length];
    const label = a.custom_name || a.name || LABEL_UNNAMED;
    accountsDonutData.push({ id: a.id, value, color, label });
  });

  const currencyCodes = new Set(filteredAccounts.map((a) => a.balances.iso_currency_code || "USD"));
  const currencyCode = currencyCodes.values().next().value || "USD";
  const currencySymbol = currencyCodeToSymbol(currencyCode);

  return (
    <div className="AccountsDonut">
      <div className="donut">
        <Donut data={accountsDonutData} radius={60} thickness={10} />
        <div className="centerLabel">
          <span>
            {currencyCodeToSymbol(currencyCode)}
            &nbsp;{numberToCommaString(balanceTotal, 0)}
          </span>
        </div>
      </div>
      <div className="legend">
        <BalanceBreakDown currencySymbol={currencySymbol} donutData={accountsDonutData} />
      </div>
    </div>
  );
};

export default AccountsDonut;
