import { ReactNode } from "react";
import { GraphLabel, Range } from ".";

interface Props {
  range: Range;
  labelX: GraphLabel;
  labelY: GraphLabel;
}

const Grid = ({ range, labelX, labelY }: Props) => {
  const horizontalLineDivs: ReactNode[] = [];

  const M = 4;
  for (let i = M - 1; 0 <= i; i--) {
    const lineDiv = <div key={i}>{labelY.get(i, M, range.y)}</div>;
    horizontalLineDivs.push(lineDiv);
  }

  const bottomLabels: ReactNode[] = [];

  const N = 6;
  for (let i = N - 1; 0 <= i; i--) {
    const labelDiv = <div key={i}>{i === N - 1 ? "" : labelX.get(i, N, range.x)}</div>;
    bottomLabels.push(labelDiv);
  }

  const horizontalDirection = labelX.direction === "right" ? "right" : "left";
  const verticalDirection = labelY.direction === "bottom" ? "bottom" : "top";

  return (
    <div className="Grid">
      <div className={`horizontal ${horizontalDirection}`}>{horizontalLineDivs}</div>
      <div className={`vertical ${verticalDirection}`}>{bottomLabels}</div>
    </div>
  );
};

export default Grid;
