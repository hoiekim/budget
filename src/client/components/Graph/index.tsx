import Grid from "./Grid";
import Line from "./Line";
import "./index.css";

export type Point = [number, number];
export interface Range {
  x: Point;
  y: Point;
}

export interface GraphData {
  lines: { points: Point[]; color: string }[];
  range: Range;
}

interface Props {
  data: GraphData;
  iso_currency_code: string | null;
}

const Graph = ({ data: { lines, range }, iso_currency_code }: Props) => {
  const lineElements = lines.map(({ points, color }) => {
    return <Line points={points} color={color} />;
  });
  return (
    <div className="Graph">
      <Grid range={range} iso_currency_code={iso_currency_code} />
      {lineElements}
    </div>
  );
};

export default Graph;
