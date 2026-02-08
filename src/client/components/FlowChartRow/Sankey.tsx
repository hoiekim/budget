import { Line, Point, useMemoryState } from "client";
import { useEffect, useMemo, useRef } from "react";
import { getLinkPathData, getVerticalLines, SankeyColumn, SankeyRow } from "./lib";

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

  const heightMinusBottomMargin = height - 5;

  const [link1, link2, link3, link4] = useMemo(() => {
    const numberOfMargins = Math.max(...data.map((col) => col.length)) - 1;
    return [
      getLinkPath(
        column1,
        column2,
        numberOfMargins,
        0,
        Math.ceil(width * (1 / 4)),
        heightMinusBottomMargin,
      ),
      getLinkPath(
        column2,
        column3,
        numberOfMargins,
        Math.floor(width * (1 / 4)),
        Math.ceil(width * (2 / 4)),
        heightMinusBottomMargin,
      ),
      getLinkPath(
        column4,
        column3,
        numberOfMargins,
        Math.ceil(width * (3 / 4)),
        Math.floor(width * (2 / 4)),
        heightMinusBottomMargin,
      ),
      getLinkPath(
        column5,
        column4,
        numberOfMargins,
        Math.ceil(width),
        Math.floor(width * (3 / 4)),
        heightMinusBottomMargin,
      ),
    ];
  }, [column1, column2, column3, column4, column5, width, heightMinusBottomMargin, data]);

  const [text1, text2, text3, text4, text5] = useMemo(() => {
    const numberOfMargins = Math.max(...data.map((col) => col.length)) - 1;
    return [
      getText(column1, numberOfMargins, heightMinusBottomMargin, [0, 0]),
      getText(column2, numberOfMargins, heightMinusBottomMargin, [width * (1 / 4), 0], "start"),
      getText(column3, numberOfMargins, heightMinusBottomMargin, [width * (1 / 2), 0], "middle"),
      getText(column4, numberOfMargins, heightMinusBottomMargin, [width * (3 / 4), 0], "end"),
      getText(column5, numberOfMargins, heightMinusBottomMargin, [width, 0], "end"),
    ];
  }, [column1, column2, column3, column4, column5, width, heightMinusBottomMargin, data]);

  return (
    <div className="Sankey" ref={divRef} style={{ width: "100%", height }}>
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
  const combined: { line: Line; row: SankeyRow }[] = [];
  column.forEach((row, i) => combined.push({ line: lines[i], row }));

  const sorted = combined.sort((a, b) => {
    return (b.row.priority ?? 0) - (a.row.priority ?? 0) || b.row.amount - a.row.amount;
  });

  const jsxElements: JSX.Element[] = [];
  const ys: number[] = [];

  sorted.forEach(({ line, row }) => {
    const { start, end } = line;
    const mid = (start + end) / 2;
    const y = (1 - mid) * height;
    if (ys.find((e) => Math.abs(y - e) < 24)) return;
    ys.push(y);
    jsxElements.push(
      <text
        key={row.id}
        x={offset[0]}
        y={y}
        fill="#fff"
        dominantBaseline="central"
        textAnchor={textAnchor}
        fontSize={10}
      >
        {row.name}
      </text>,
    );
  });

  return jsxElements;
};
