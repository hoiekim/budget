import { numberToCommaString } from "common";
import { DonutData } from "client/components";

interface Props {
  currencySymbol: string;
  childrenDonutData: DonutData[];
  childToGrandChildrenMap: Map<string, DonutData[]>;
}

const ID_DIFF = "diff";

const CapacityBreakDown = ({
  currencySymbol,
  childrenDonutData,
  childToGrandChildrenMap,
}: Props) => {
  const capacityBreakDown = childrenDonutData
    .filter((c, i) => !(c.id === ID_DIFF && i === childrenDonutData.length - 1))
    .flatMap((c, i) => {
      const grandChildrenDonutData = childToGrandChildrenMap.get(c.id) || [];
      const adjustments = grandChildrenDonutData.filter((gc) => gc.id === ID_DIFF);
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
        ...adjustments.map((a, j) => (
          <tr key={`capacityBreakDown_row_${i}_${j}`}>
            <td>
              <div
                className="colored"
                style={{ width: "5px", height: "12px", backgroundColor: a.color }}
              />
            </td>
            <td />
            <td className="colored alert">
              -&nbsp;{currencySymbol}&nbsp;{numberToCommaString(a.value, 0)}
            </td>
          </tr>
        )),
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

export default CapacityBreakDown;
