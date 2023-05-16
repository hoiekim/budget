import Grid from "./Grid";
import Line from "./Line";
import { GraphInput, getGraphData } from "./lib";
import "./index.css";

export * from "./lib";

export type Point = [number, number];
export interface Range {
  x: Point;
  y: Point;
}
export type LineType = "perpendicular" | "diagonal";

export interface GraphData {
  lines: { points: Point[]; color: string; type?: LineType }[];
  range: Range;
}

interface Props {
  data: GraphInput[];
  iso_currency_code: string | null;
}

const Graph = ({ data, iso_currency_code }: Props) => {
  const { lines, range } = getGraphData(data);
  const lineElements = lines.map(({ points, color, type }, i) => {
    return <Line key={`graphLine_${i}`} points={points} color={color} type={type} />;
  });
  return (
    <div className="Graph">
      <Grid range={range} iso_currency_code={iso_currency_code} />
      {lineElements}
    </div>
  );
};

export default Graph;
