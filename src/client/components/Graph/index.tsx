import Grid from "./Grid";
import Line from "./Line";
import Area from "./Area";
import Dot from "./Dot";
import { GraphInput, GraphLabel, getGraphData } from "./lib";
import "./index.css";

export * from "./lib";

interface Props {
  data: GraphInput;
  labelX: GraphLabel;
  labelY: GraphLabel;
  memoryKey?: string;
}

export const Graph = ({ data, labelX, labelY, memoryKey }: Props) => {
  const { lines, areas, points, range, labelDirectionX, labelDirectionY } = getGraphData(data);
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

  const pointElements = points?.map(({ point, color }, i) => {
    return (
      <Dot key={`graphPoint_${i}`} point={point} color={color} memoryKey={`${memoryKey}_point`} />
    );
  });

  return (
    <div className="Graph">
      <Grid range={range} labelX={labelX} labelY={labelY} />
      {areaElements}
      {lineElements}
      {pointElements}
    </div>
  );
};
