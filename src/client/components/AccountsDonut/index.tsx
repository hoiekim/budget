import { Donut } from "client";
import { numberToCommaString } from "common";
import { DonutData } from "client/components";
import { BalanceInfo } from "./BalanceInfo";
import "./index.css";

interface Props {
  balanceTotal: number;
  currencySymbol: string;
  donutData: DonutData[];
  radius: number;
}

export const AccountsDonut = ({ balanceTotal, currencySymbol, donutData, radius }: Props) => {
  const isShrunk = radius < 50;
  return (
    <div className="AccountsDonut">
      <div className="donut">
        <Donut data={donutData} radius={radius} thickness={10} />
        <div className="centerLabel">
          <span>
            {currencySymbol}
            &nbsp;{numberToCommaString(balanceTotal, 0)}
          </span>
        </div>
      </div>
      <BalanceInfo
        balanceTotal={balanceTotal}
        currencySymbol={currencySymbol}
        donutData={donutData}
        isShrunk={isShrunk}
      />
    </div>
  );
};
