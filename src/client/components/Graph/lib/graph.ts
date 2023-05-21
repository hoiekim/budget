import { LabelDirection } from "./label";

export type Point = [number, number];

export interface Range {
  x: Point;
  y: Point;
}

export type LineType = "perpendicular" | "diagonal";

export interface LineData {
  points: (Point | undefined)[];
  color: string;
  type?: LineType;
}

export interface AreaData {
  upperBound: (Point | undefined)[];
  lowerBound: (Point | undefined)[];
  color: string;
  type?: LineType;
}

export interface PointData {
  point: Point;
  color: string;
}

export interface GraphData {
  range: Range;
  lines?: LineData[];
  areas?: AreaData[];
  points?: PointData[];
  labelDirectionX?: LabelDirection;
  labelDirectionY?: LabelDirection;
}

export type Sequence = (number | undefined)[];

export interface LineInput {
  sequence: Sequence;
  color: string;
  type?: LineType;
}

export interface AreaInput {
  upperBound: Sequence;
  lowerBound: Sequence;
  color: string;
  type?: LineType;
}

export interface PointInput {
  point: { value: number; index: number };
  color: string;
}

export interface GraphInput {
  lines?: LineInput[];
  areas?: AreaInput[];
  points?: PointInput[];
}

/**
 * Converts GraphInput type arguments into GraphData type object. Using this
 * function simplifies graph drawing process by allowing input as "Sequence",
 * which is just array of numbers instead of full coordinate points. This
 * simplification necessarily introduce ambiguity when it comes to x-axis unit.
 * Basically x-axis is presented as "index"(of the sequence array) and Grid
 * component is responsible to convert index into meaningful labels to display.
 */
export const getGraphData = (input: GraphInput): GraphData => {
  const allSequences: Sequence[] = [];

  input.lines?.forEach(({ sequence }) => allSequences.push(sequence));

  input.areas?.forEach(({ upperBound, lowerBound }) => {
    allSequences.push(upperBound);
    allSequences.push(lowerBound);
  });

  const sequenceFromPoints: Sequence = [];
  allSequences.push(sequenceFromPoints);
  input.points?.forEach(({ point: { value, index } }) => {
    sequenceFromPoints[index] = value;
  });

  const rangeX: Point = [0, Math.max(...allSequences.map((e) => e.length)) - 1];
  const rangeY: Point = getRangeY(allSequences.flat());
  const range: Range = { x: [rangeX[0], rangeX[1]], y: rangeY };

  const lines = input.lines?.map(({ sequence, color, type }) => {
    return { points: getPoints(sequence, range), color, type };
  });

  const areas = input.areas?.map(({ upperBound, lowerBound, color, type }) => {
    return {
      upperBound: getPoints(upperBound, range),
      lowerBound: getPoints(lowerBound, range),
      color: color,
      type: type,
    };
  });

  const points =
    input.points?.map(({ point, color }) => {
      return { point: mapSequence(point.value, point.index, range) as Point, color };
    }) || [];

  let topEdges = 0;
  let bottomEdges = 0;

  allSequences.flat().forEach((e) => {
    if (!e) return;
    const factor = e / range.y[1];
    if (0.75 < factor) topEdges++;
    if (factor < 0.25) bottomEdges++;
  });

  const labelDirectionY = topEdges < bottomEdges ? "top" : "bottom";

  return { lines, areas, range, points, labelDirectionY };
};

const getPoints = (sequence: Sequence, range: Range): (Point | undefined)[] => {
  return sequence.map((e: number | undefined, i: number) => mapSequence(e, i, range));
};

const mapSequence = (
  value: number | undefined,
  index: number,
  range: Range
): Point | undefined => {
  const [minX, maxX] = range.x;
  const [minY, maxY] = range.y;

  if (value === undefined) return undefined;
  const x = minX === maxX ? 0.5 : index / maxX;
  const y = maxY === minY ? 0.5 : (value - minY) / (maxY - minY) || 0;
  return [x, y];
};

const getRangeY = (sequence: Sequence): Point => {
  const definedSequence = sequence.filter((e) => e !== undefined) as number[];
  let min = Math.min(...definedSequence);
  let max = Math.max(...definedSequence);

  const maxDigits = max.toFixed(0).length;
  const fixer = Math.pow(10, maxDigits - 2);
  max = Math.ceil(max / fixer);
  min = Math.floor(min / fixer);

  const gap = [8, 12, 16, 20, 24, 32, 40, 60, 80, 100].reduce((a, b) => {
    const distA = max - min + (min % (a / 4)) - a;
    const distB = max - min + (min % (b / 4)) - b;
    if (0 < distA && distB < distA) return b;
    return a;
  }, 8);

  min = min - (min % (gap / 4));
  max = min + gap;

  max *= fixer;
  min *= fixer;

  return [min, max];
};
