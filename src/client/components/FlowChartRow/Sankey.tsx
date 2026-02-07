import { Line, Point, useMemoryState } from "client";
import { useEffect, useMemo, useRef } from "react";
import { getLinkPathData, getVerticalLines, SankeyColumn } from "./lib";

export interface SankeyProps {
  memoryKey: string;
  data: SankeyColumn[];
  height: number;
}

export const Sankey = ({ memoryKey, data, height }: SankeyProps) => {
  const [column1, column2, column3, column4, column5] = data;

  const [width, setWidth] = useMemoryState(`graph_svgWidth_${memoryKey}`, 0);

  const divRef = useRef<HTMLDivElement>(null);

  const observerRef = useRef(
    new ResizeObserver((entries) => {
      const element = entries[0];
      setWidth(element.contentRect.width);
    }),
  );

  useEffect(() => {
    const div = divRef.current;
    const observer = observerRef.current;
    if (div) observer.observe(div);

    return () => {
      if (div) observer.unobserve(div);
    };
  }, []);

  const [link1, link2, link3, link4] = useMemo(() => {
    const numberOfMargins = Math.max(...data.map((col) => col.length)) - 1;
    return [
      getLinkPath(column1, column2, numberOfMargins, 0, Math.ceil(width * (1 / 4)), height),
      getLinkPath(
        column2,
        column3,
        numberOfMargins,
        Math.floor(width * (1 / 4)),
        Math.ceil(width * (2 / 4)),
        height,
      ),
      getLinkPath(
        column4,
        column3,
        numberOfMargins,
        Math.ceil(width * (3 / 4)),
        Math.floor(width * (2 / 4)),
        height,
      ),
      getLinkPath(
        column5,
        column4,
        numberOfMargins,
        Math.ceil(width),
        Math.floor(width * (3 / 4)),
        height,
      ),
    ];
  }, [column1, column2, column3, column4, column5, width, height, data]);

  const [text1, text2, text3, text4, text5] = useMemo(() => {
    const numberOfMargins = Math.max(...data.map((col) => col.length)) - 1;
    return [
      getText(column1, numberOfMargins, height, [0, 0]),
      getText(column2, numberOfMargins, height, [width * (1 / 4), 0], "start"),
      getText(column3, numberOfMargins, height, [width * (1 / 2), 0], "middle"),
      getText(column4, numberOfMargins, height, [width * (3 / 4), 0], "end"),
      getText(column5, numberOfMargins, height, [width, 0], "end"),
    ];
  }, [column1, column2, column3, column4, column5, width, height, data]);

  return (
    <div className="Sankey" ref={divRef} style={{ width: "100%" }}>
      <svg
        className="colored"
        height="100%"
        width="100%"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
      >
        {link1}
        {link2}
        {link3}
        {link4}
        {text1}
        {text2}
        {text3}
        {text4}
        {text5}
      </svg>
    </div>
  );
};

const getLinkPath = (
  sourceColumn: SankeyColumn,
  targetColumn: SankeyColumn,
  numberOfMargins: number,
  sourceOffset: number,
  targetOffset: number,
  height: number,
) => {
  const sourceLines = getVerticalLines(sourceColumn, numberOfMargins);
  const targetLines = getVerticalLines(targetColumn, numberOfMargins);
  const targets = new Set(sourceColumn.map((row) => row.next));
  const pathData: { key: string; d: string; startColor: string; endColor: string }[] = [];
  targetLines.forEach((targetLine, i) => {
    if (!targets.has(targetColumn[i]?.id)) return;
    const filteredSourceLines: Line[] = [];
    const filteredSourceRows = sourceColumn.filter((row, j) => {
      if (row.next === targetColumn[i]?.id) {
        filteredSourceLines.push(sourceLines[j]);
        return true;
      }
      return false;
    });
    const data = getLinkPathData(
      filteredSourceLines,
      targetLine,
      sourceOffset,
      targetOffset,
      height,
    ).map((d, j) => {
      return {
        key: `${filteredSourceRows[j]?.id}_${targetColumn[i]?.id}_link`,
        d,
        startColor: filteredSourceRows[j]?.color || "#555",
        endColor: targetColumn[i]?.color || "#555",
      };
    });
    pathData.push(...data);
  });
  const direction = sourceOffset < targetOffset;
  return pathData.flatMap(({ key, d, startColor, endColor }) => {
    const gradientId = `gradient-${key}`;
    return [
      startColor === endColor ? undefined : (
        <defs key={`${key}_defs`}>
          <linearGradient
            id={gradientId}
            x1={direction ? "0%" : "100%"}
            y1="0%"
            x2={direction ? "100%" : "0%"}
            y2="0%"
          >
            <stop offset="0%" stopColor={startColor} />
            <stop offset="100%" stopColor={endColor} />
          </linearGradient>
        </defs>
      ),
      <path
        key={key}
        d={d}
        style={{
          strokeLinecap: "square",
          strokeLinejoin: "miter",
          fill: startColor === endColor ? startColor : `url(#${gradientId})`,
        }}
      />,
    ];
  });
};

const getText = (
  column: SankeyColumn,
  numberOfMargins: number,
  height: number,
  offset: Point = [0, 0],
  textAnchor: "start" | "middle" | "end" = "start",
) => {
  const lines = getVerticalLines(column, numberOfMargins);
  let lastY = 0;
  return lines.map(({ start, end }, i) => {
    const priority = column[i].priority || 0;
    const nextPriority = column[i + 1]?.priority || 0;

    const nextLine = lines[i + 1];
    const nextMid = nextLine && (nextLine.start + nextLine.end) / 2;

    const mid = (start + end) / 2;
    const y = (1 - mid) * height;
    const nextY = nextMid && (1 - nextMid) * height;

    if (lastY && y - lastY < 16) return undefined;
    if (nextPriority && nextY && nextY - y < 16 && priority < nextPriority) return undefined;

    lastY = y;

    return (
      <text
        key={column[i].id}
        x={offset[0]}
        y={y}
        fill="#fff"
        dominant-baseline="central"
        textAnchor={textAnchor}
        fontSize={10}
      >
        {column[i].name}
      </text>
    );
  });
};
