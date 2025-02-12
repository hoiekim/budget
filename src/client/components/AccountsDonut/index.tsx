import { Donut, colors, useAppContext } from "client";
import { currencyCodeToSymbol, numberToCommaString } from "common";
import { DonutData } from "client/components";
import BalanceBreakDown from "./BalanceBreakDown";
import "./index.css";

const LABEL_UNNAMED = "Unnamed";

const AccountsDonut = () => {
  const { data } = useAppContext();
  const { accounts } = data;

  let balanceTotal = 0;
  const accountsDonutData: DonutData[] = [];

  accounts
    .toArray()
    .sort((a, b) => (b.balances.current || 0) - (a.balances.current || 0))
    .forEach((a, i) => {
      if (a.hide) return;
      const value = a.balances.current;
      if (!value) return;
      balanceTotal += value;
      const color = colors[i % colors.length];
      const label = a.custom_name || a.name || LABEL_UNNAMED;
      accountsDonutData.push({ id: a.id, value, color, label });
    });

  const currencyCodes = new Set(
    accounts.toArray().map((a) => a.balances.iso_currency_code || "USD")
  );
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
