import Grid from "./Grid";
import Line from "./Line";
import { GraphInput, GraphLabel, getGraphData } from "./lib";
import "./index.css";
import Area from "./Area";

export * from "./lib";

interface Props {
  data: GraphInput;
  labelX: GraphLabel;
  labelY: GraphLabel;
  memoryKey?: string;
}

const Graph = ({ data, labelX, labelY, memoryKey }: Props) => {
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
      <Grid
        range={range}
        getLabelX={(i, div) => labelX.get(i, div, range.x)}
        getLabelY={(i, div) => labelY.get(i, div, range.y)}
      />
      {areaElement}
      {lineElements}
    </div>
  );
};

export default Graph;
