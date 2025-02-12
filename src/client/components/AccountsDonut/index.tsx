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
  const childrenDonutData: DonutData[] = [];

  accounts.toArray().forEach((a, i) => {
    if (a.hide) return;
    const childValue = a.balances.current;
    if (!childValue) return;
    balanceTotal += childValue;
    const childColor = colors[i % colors.length];
    const childLabel = a.custom_name || a.name || LABEL_UNNAMED;
    childrenDonutData.push({
      id: a.id,
      value: childValue,
      color: childColor,
      label: childLabel,
    });
  });

  const currencyCodes = new Set(
    accounts.toArray().map((a) => a.balances.iso_currency_code || "USD")
  );
  const currencyCode = currencyCodes.values().next().value || "USD";
  const currencySymbol = currencyCodeToSymbol(currencyCode);

  return (
    <div className="AccountsDonut">
      <div className="donut">
        <Donut data={childrenDonutData} radius={60} thickness={10} />
        <div className="centerLabel">
          <span>
            {currencyCodeToSymbol(currencyCode)}
            &nbsp;{numberToCommaString(balanceTotal, 0)}
          </span>
        </div>
      </div>
      <div className="legend">
        <BalanceBreakDown currencySymbol={currencySymbol} childrenDonutData={childrenDonutData} />
      </div>
    </div>
  );
};

export default AccountsDonut;
