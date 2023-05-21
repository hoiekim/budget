import Grid from "./Grid";
import Line from "./Line";
import Area from "./Area";
import { GraphInput, GraphLabel, getGraphData } from "./lib";
import "./index.css";

export * from "./lib";

interface Props {
  data: GraphInput;
  labelX: GraphLabel;
  labelY: GraphLabel;
  memoryKey?: string;
}

const Graph = ({ data, labelX, labelY, memoryKey }: Props) => {
  const { lines, areas, range, labelDirectionX, labelDirectionY } = getGraphData(data);
  if (labelDirectionX) labelX.direction = labelDirectionX;
  if (labelDirectionY) labelY.direction = labelDirectionY;

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

  const areaElements = areas?.map(({ upperBound, lowerBound, color, type }, i) => {
    return (
      <Area
        key={`graphArea_${i}`}
        upperBound={upperBound}
        lowerBound={lowerBound}
        color={color}
        type={type}
        memoryKey={`${memoryKey}_area`}
      />
    );
  });

  return (
    <div className="Graph">
      <Grid range={range} labelX={labelX} labelY={labelY} />
      {areaElements}
      {lineElements}
    </div>
  );
};

export default Graph;
