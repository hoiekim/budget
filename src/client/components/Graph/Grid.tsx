import { ReactNode } from "react";
import { GraphLabel, Range } from ".";

interface Props {
  range: Range;
  labelX: GraphLabel;
  labelY: GraphLabel;
  height?: number;
}

const Grid = ({ range, labelX, labelY, height }: Props) => {
  const horizontalLineDivs: ReactNode[] = [];

  const M = height && height < 100 ? 2 : 4;
  for (let i = M - 1; 0 <= i; i--) {
    const lineDiv = <div key={i}>{labelY.get(i, M, range.y)}</div>;
    horizontalLineDivs.push(lineDiv);
  }

  const bottomLabels: ReactNode[] = [];

  const N = height && height < 100 ? 2 : 6;
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
