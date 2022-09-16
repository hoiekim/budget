import Grid from "./Grid";
import Line from "./Line";
import "./index.css";

export type Point = [number, number];
export interface Range {
  x: Point;
  y: Point;
}

export interface GraphData {
  points: Point[];
  range: Range;
  iso_currency_code: string | null;
}

interface Props {
  data: GraphData;
}

const Graph = ({ data: { points, range, iso_currency_code } }: Props) => {
  return (
    <div className="Graph">
      <Grid range={range} iso_currency_code={iso_currency_code} />
      <Line points={points} />
    </div>
  );
};

export default Graph;
