import { numberToCommaString } from "common";
import { DonutData } from "client/components";

interface Props {
  currencySymbol: string;
  donutData: DonutData[];
}

const BalanceBreakDown = ({ currencySymbol, donutData }: Props) => {
  const capacityBreakDown = donutData.flatMap((c, i) => {
    return [
      <tr key={`capacityBreakDown_row_${i}`}>
        <td>
          <div
            className="colored"
            style={{ width: "5px", height: "12px", backgroundColor: c.color }}
          />
        </td>
        <td>{c.label}</td>
        <td>
          {currencySymbol}&nbsp;{numberToCommaString(c.value, 0)}
        </td>
      </tr>,
    ];
  });

  return (
    <div className="CapacityBreakDown">
      <table>
        <tbody>{capacityBreakDown}</tbody>
      </table>
    </div>
  );
};

export default BalanceBreakDown;
