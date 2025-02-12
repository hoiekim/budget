import { numberToCommaString } from "common";
import { DonutData } from "client/components";

interface Props {
  currencySymbol: string;
  childrenDonutData: DonutData[];
}

const ID_DIFF = "diff";

const BalanceBreakDown = ({ currencySymbol, childrenDonutData }: Props) => {
  const capacityBreakDown = childrenDonutData
    .filter((c, i) => !(c.id === ID_DIFF && i === childrenDonutData.length - 1))
    .flatMap((c, i) => {
      return [
        <tr
          key={`capacityBreakDown_row_${i}`}
          className={c.id === ID_DIFF ? "colored alert" : undefined}
        >
          <td>
            <div
              className="colored"
              style={{ width: "5px", height: "12px", backgroundColor: c.color }}
            />
          </td>
          <td>{c.label}</td>
          <td>
            {c.id === ID_DIFF && <>+&nbsp;</>}
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
