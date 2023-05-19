export type Point = [number, number];
export interface Range {
  x: Point;
  y: Point;
}
export type LineType = "perpendicular" | "diagonal";

export interface GraphData {
  lines?: { points: (Point | undefined)[]; color: string; type?: LineType }[];
  area?: {
    upperBound: (Point | undefined)[];
    lowerBound: (Point | undefined)[];
    color: string;
    type?: LineType;
  };
  range: Range;
}

export type Sequence = (number | undefined)[];
export type LineInput = { sequence: Sequence; color: string; type?: LineType };
export type AreaInput = {
  upperBound: Sequence;
  lowerBound: Sequence;
  color: string;
  type?: LineType;
};
export type GraphInput = { lines?: LineInput[]; area?: AreaInput };

export const getGraphData = (input: GraphInput): GraphData => {
  const allSequences: Sequence[] = [];
  input.lines?.forEach(({ sequence }) => allSequences.push(sequence));
  input.area?.upperBound && allSequences.push(input.area.upperBound);
  input.area?.lowerBound && allSequences.push(input.area.lowerBound);
  const rangeX: Point = [0, Math.max(...allSequences.map((e) => e.length)) - 1];
  const fixerX = 3 - (rangeX[1] % 3);
  const rangeY: Point = getRangeY(allSequences.flat());
  const range: Range = { x: [rangeX[0], rangeX[1]], y: rangeY };

  const lines = input.lines?.map(({ sequence, color, type }) => {
    return { points: getPoints(sequence, range), color, type };
  });

  if (!input.area) return { lines, range };

  const { upperBound, lowerBound, color, type } = input.area;

  const area = {
    upperBound: getPoints(upperBound, range),
    lowerBound: getPoints(lowerBound, range),
    color: color,
    type: type,
  };

  return { lines, area, range };
};

const getPoints = (sequence: Sequence, range: Range): (Point | undefined)[] => {
  const [minX, maxX] = range.x;
  const [minY, maxY] = range.y;

  return sequence.map((e, i): Point | undefined => {
    if (e === undefined) return undefined;
    const x = minX === maxX ? 0.5 : i / maxX;
    const y = maxY === minY ? 0.5 : (e - minY) / (maxY - minY) || 0;
    return [x, y];
  });
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
