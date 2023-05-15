import { GraphData, Point, Range } from "client/components/Graph";

export type Sequence = number[];

export type GraphInput = { sequence: Sequence; color: string }[];

export const getGraphData = (input: GraphInput): GraphData => {
  const ranges = input.map(({ sequence }) => getRange(sequence));
  const range = ranges.reduce(
    (acc, e) => {
      return {
        y: [Math.min(acc.y[0], e.y[0]), Math.max(acc.y[1], e.y[1])],
        x: [Math.min(acc.x[0], e.x[0]), Math.max(acc.x[1], e.x[1])],
      };
    },
    { y: [0, 0], x: [0, 0] }
  );
  const lines = input.map(({ sequence, color }) => {
    return { points: getPoints(sequence, range), color };
  });
  return { lines, range };
};

export const getPoints = (sequence: Sequence, range: Range): Point[] => {
  const { length } = sequence;
  const [min, max] = range.y;

  const points = sequence.map((e, i): Point => {
    const x = length === 1 ? 0.5 : i / (length - 1);
    const y = max === min ? 0.5 : (e - min) / (max - min) || 0;
    return [x, y];
  });

  return points;
};

export const getRange = (sequence: Sequence): Range => {
  const { length } = sequence;

  let min = sequence[0];
  let max = sequence[0];

  for (let i = 1; i < length; i++) {
    min = Math.min(min, sequence[i]);
    max = Math.max(max, sequence[i]);
  }

  const maxDigits = max.toFixed(0).length - 1;
  const fixer = Math.pow(10, maxDigits - 1);
  max = Math.ceil(max / fixer);
  min = Math.floor(min / fixer);

  let i = 0;
  while ((max - min) % 4) {
    if (i % 2) min -= 1;
    else max += 1;
    i++;
  }

  max *= fixer;
  min *= fixer;

  return { y: [min, max], x: [0, length - 1] };
};
