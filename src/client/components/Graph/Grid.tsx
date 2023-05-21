import { ReactNode } from "react";
import { Range } from ".";

interface Props {
  range: Range;
  getLabelX: (i: number, division: number) => string;
  getLabelY: (i: number, division: number) => string;
}

const Grid = ({ getLabelX, getLabelY }: Props) => {
  const horizontalLineDivs: ReactNode[] = [];

  const M = 4;
  for (let i = M - 1; 0 <= i; i--) {
    const lineDiv = <div key={i}>{getLabelY(i, M)}</div>;
    horizontalLineDivs.push(lineDiv);
  }

  const verticalLineDivs: ReactNode[] = [];

  const N = 6;
  for (let i = N - 1; 0 <= i; i--) {
    const lineDiv = <div key={i}>{getLabelX(i, N)}</div>;
    verticalLineDivs.push(lineDiv);
  }

  return (
    <div className="Grid">
      <div className="horizontal">{horizontalLineDivs}</div>
      <div className="vertical">{verticalLineDivs}</div>
    </div>
  );
};

export default Grid;
