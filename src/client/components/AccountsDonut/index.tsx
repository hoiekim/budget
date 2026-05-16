import { Donut } from "client";
import { numberToCommaString } from "common";
import { DonutData } from "client/components";
import { BalanceInfo } from "./BalanceInfo";
import "./index.css";
import { CSSProperties } from "react";

interface Props {
  balanceTotal: number;
  currencySymbol: string;
  donutData: DonutData[];
  totalCredit: number;
  numberOfCredits: number;
  radius: number;
  style?: CSSProperties;
}

export const AccountsDonut = ({
  balanceTotal,
  currencySymbol,
  donutData,
  totalCredit,
  numberOfCredits,
  radius,
  style,
}: Props) => {
  const isShrunk = radius < 50;
  return (
    <div className="AccountsDonut" style={style}>
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
        currencySymbol={currencySymbol}
        donutData={donutData}
        totalCredit={totalCredit}
        numberOfCredits={numberOfCredits}
        isShrunk={isShrunk}
      />
    </div>
  );
};
