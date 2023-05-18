import Grid from "./Grid";
import Line from "./Line";
import { GraphInput, getGraphData } from "./lib";
import "./index.css";
import Area from "./Area";

export * from "./lib";

interface Props {
  data: GraphInput;
  iso_currency_code: string | null;
  memoryKey?: string;
}

const Graph = ({ data, iso_currency_code, memoryKey }: Props) => {
  const { lines, area, range } = getGraphData(data);
  const lineElements = lines?.map(({ points, color, type }, i) => {
    return (
      <Line
        key={`graphLine_${i}`}
        points={points}
        color={color}
        type={type}
        memoryKey={`${memoryKey}_${i}`}
      />
    );
  });
  const areaElement = area && (
    <Area
      upperBound={area.upperBound}
      lowerBound={area.lowerBound}
      color={area.color}
      type={area.type}
      memoryKey={`${memoryKey}_area`}
    />
  );
  return (
    <div className="Graph">
      <Grid range={range} iso_currency_code={iso_currency_code} />
      {areaElement}
      {lineElements}
    </div>
  );
};

export default Graph;
