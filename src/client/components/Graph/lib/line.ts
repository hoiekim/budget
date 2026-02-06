import { LineType, Point } from "./graph";

export const pointsToCoordinateString = (
  points: (Point | undefined)[],
  width: number,
  height: number,
  type: LineType,
) => {
  return points
    .flatMap((e, i) => {
      if (!e) return [];
      // hardcoded 5px margin around all 4 sides.
      const x = e[0] * (width - 10) + 5;
      const y = (1 - e[1]) * (height - 10) + 5;
      if (type === "diagonal") return [`${x},${y}`];

      const prev = points[i - 1];
      const next = points[i + 1];
      const offset = Math.abs((e[0] - (prev || next || [0])[0]) * (width - 10)) / 2;
      if (prev === undefined) {
        if (next === undefined) return [`${x},${y}`];
        else return [`${x},${y}`, `${x + offset},${y}`];
      }
      if (next === undefined) return [`${x - offset},${y}`, `${x},${y}`];
      return [`${x - offset},${y}`, `${x + offset},${y}`];
    })
    .filter((e) => e);
};

export const pointsToCoordinate = (
  points: Point[],
  width: number,
  height: number,
  type: LineType,
): Point[] => {
  return points.flatMap((e, i): Point[] => {
    const x = e[0] * width;
    const y = (1 - e[1]) * height;
    if (type === "diagonal") return [[x, y]];

    const prev = points[i - 1];
    const next = points[i + 1];
    const offset = Math.abs((e[0] - (prev || next || [0])[0]) * width) / 2;
    if (prev === undefined) {
      if (next === undefined) return [[x, y]];
      else
        return [
          [x, y],
          [x + offset, y],
        ];
    }
    if (next === undefined)
      return [
        [x - offset, y],
        [x, y],
      ];
    return [
      [x - offset, y],
      [x + offset, y],
    ];
  });
};
