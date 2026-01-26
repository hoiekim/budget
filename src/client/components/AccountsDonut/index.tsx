import { Donut } from "client";
import { numberToCommaString } from "common";
import { DonutData } from "client/components";
import "./index.css";

interface Props {
  balanceTotal: number;
  currencySymbol: string;
  donutData: DonutData[];
}

export const AccountsDonut = ({ balanceTotal, currencySymbol, donutData }: Props) => {
  return (
    <div className="AccountsDonut">
      <div className="donut">
        <Donut data={donutData} radius={80} thickness={10} />
        <div className="centerLabel">
          <span>
            {currencySymbol}
            &nbsp;{numberToCommaString(balanceTotal, 0)}
          </span>
        </div>
      </div>
    </div>
  );
};
