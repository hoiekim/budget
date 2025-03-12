import { LabelDirection } from "./label";

export type Point = [number, number];

export interface Range {
  x: Point;
  y: Point;
}

export type LineType = "perpendicular" | "diagonal";
export type StrokeType = "solid" | "dashed";

export interface LineData {
  points: (Point | undefined)[];
  color: string;
  type?: LineType;
  strokeType?: StrokeType;
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
  guideX?: boolean;
  guideY?: boolean;
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
  strokeType?: StrokeType;
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
  guideX?: boolean;
  guideY?: boolean;
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
  const mergedSequence: { min?: number; max?: number }[] = [];

  const mergeSequence = (sequence: Sequence) => {
    sequence.forEach((e, i) => {
      if (!mergedSequence[i]) mergedSequence[i] = {};
      if (e !== undefined) {
        mergedSequence[i].min = Math.min(e, mergedSequence[i].min || e);
        mergedSequence[i].max = Math.max(e, mergedSequence[i].max || e);
      }
    });
  };

  input.lines?.forEach(({ sequence }) => mergeSequence(sequence));

  input.areas?.forEach(({ upperBound, lowerBound }) => {
    mergeSequence(upperBound);
    mergeSequence(lowerBound);
  });

  const sequenceFromPoints: Sequence = [];
  mergeSequence(sequenceFromPoints);
  input.points?.forEach(({ point: { value, index } }) => {
    sequenceFromPoints[index] = value;
  });

  const rangeX: Point = [0, mergedSequence.length - 1];
  const rangeY: Point = getRangeY(mergedSequence.flatMap((e) => [e?.min, e?.max]));
  const range: Range = { x: [rangeX[0], rangeX[1]], y: rangeY };

  const lines = input.lines?.map(({ sequence, color, type, strokeType }) => {
    return { points: getPoints(sequence, range), color, type, strokeType };
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
    input.points?.map(({ point: { index, value }, color, guideX, guideY }) => {
      const [minX, maxX] = range.x;
      const [minY, maxY] = range.y;
      const x = minX === maxX ? 0.5 : index / maxX;
      const y = maxY === minY ? 0.5 : (value - minY) / (maxY - minY) || 0;
      const point: Point = [x, y];
      return { point, color, guideX, guideY };
    }) || [];

  let topEdges = 0;
  let bottomEdges = 0;

  mergedSequence.forEach((e) => {
    if (!e) return;
    const { min, max } = e;
    const nums = [min, max];
    nums.forEach((f) => {
      if (!f) return;
      const factor = f / range.y[1];
      if (0.67 < factor) topEdges++;
      if (factor < 0.25) bottomEdges++;
    });
  });

  const labelDirectionY = topEdges < bottomEdges ? "top" : "bottom";

  return { lines, areas, range, points, labelDirectionY };
};

const getPoints = (sequence: Sequence, range: Range): (Point | undefined)[] => {
  return sequence.map((e: number | undefined, i: number) => mapSequence(e, i, range));
};

const mapSequence = (value: number | undefined, index: number, range: Range): Point | undefined => {
  const [minX, maxX] = range.x;
  const [minY, maxY] = range.y;

  if (value === undefined) return undefined;
  const x = minX === maxX ? 0.5 : index / maxX;
  const y = maxY === minY ? 0.5 : (value - minY) / (maxY - minY) || 0;
  return [x, y];
};

const getRangeY = (sequence: Sequence): Point => {
  const definedSequence = sequence.filter((e): e is number => e !== undefined);
  const actualMax = Math.max(...definedSequence);
  const actualMin = Math.min(...definedSequence);

  const maxDigits = actualMax.toFixed(0).length;
  const fixer = Math.pow(10, maxDigits - 2);
  const truncatedMax = Math.ceil(actualMax / fixer);
  const truncatedMin = Math.floor(actualMin / fixer);

  let max = truncatedMax;
  let min = truncatedMin;

  const gap = [4, 8, 12, 16, 20, 24, 32, 40, 60, 80, 100].reduce((a, b) => {
    const distA = max - min + (min % (a / 4)) - a;
    const distB = max - min + (min % (b / 4)) - b;
    if (0 < distA && distB < distA) return b;
    return a;
  }, 4);

  min = min - (min % (gap / 4));
  max = min + gap;

  while (1 <= min && truncatedMax + 1 <= max) {
    max--;
    min--;
  }

  max *= fixer;
  min *= fixer;

  return [min, max];
};
