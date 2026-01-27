import { Donut } from "client";
import { numberToCommaString } from "common";
import { DonutData } from "client/components";
import "./index.css";
import { BalanceInfo } from "./BalanceInfo";

interface Props {
  balanceTotal: number;
  currencySymbol: string;
  donutData: DonutData[];
  isShrunk: boolean;
}

export const AccountsDonut = ({ balanceTotal, currencySymbol, donutData, isShrunk }: Props) => {
  const radius = isShrunk ? 20 : 80;
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
