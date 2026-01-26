import Grid from "./Grid";
import Line from "./Line";
import Area from "./Area";
import Dot from "./Dot";
import { GraphInput, GraphLabel, getGraphData } from "./lib";
import "./index.css";

export * from "./lib";

interface Props {
  input: GraphInput;
  labelX?: GraphLabel;
  labelY?: GraphLabel;
  memoryKey?: string;
  height?: number;
}

export const Graph = ({
  input,
  labelX = new GraphLabel(),
  labelY = new GraphLabel(),
  memoryKey,
  height = 100,
}: Props) => {
  const { lines, areas, points, range, labelDirectionX, labelDirectionY } = getGraphData(input);
  if (labelDirectionX) labelX.direction = labelDirectionX;
  if (labelDirectionY) labelY.direction = labelDirectionY;

  const lineElements = lines?.map(({ points, color, type, strokeType }, i) => {
    return (
      <Line
        key={`graphLine_${i}`}
        points={points}
        color={color}
        type={type}
        strokeType={strokeType}
        memoryKey={`${memoryKey}_${i}`}
        height={height}
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
        height={height}
      />
    );
  });

  const pointElements = points?.map(({ point, color, guideX, guideY }, i) => {
    return (
      <Dot
        key={`graphPoint_${i}`}
        point={point}
        color={color}
        guideX={guideX}
        guideY={guideY}
        memoryKey={`${memoryKey}_point`}
        height={height}
      />
    );
  });

  return (
    <div className="Graph" style={{ height }}>
      <Grid range={range} labelX={labelX} labelY={labelY} height={height} />
      {areaElements}
      {lineElements}
      {pointElements}
    </div>
  );
};
