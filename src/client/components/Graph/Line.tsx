import { useEffect, useRef, useState } from "react";
import { useAppContext, useMemoryState } from "client";
import { Timeout } from "common";
import { LineType, Point } from "./index";

interface Props {
  points: Point[];
  color: string;
  type?: LineType;
  memoryKey?: string;
}

const Line = ({ memoryKey, points, color, type = "diagonal" }: Props) => {
  const { router } = useAppContext();
  const { transitioning } = router.transition;

  const pathRef = useRef<SVGPathElement>(null);
  const pathLengthMemoryKey = memoryKey && `graphLine_${memoryKey}_pathLength`;
  const [pathLength, setPathLength] = useMemoryState(pathLengthMemoryKey, 0);
  const pathOffsetMemoryKey = memoryKey && `graphLine_${memoryKey}_pathOffset`;
  const [pathOffset, setPathOffset] = useMemoryState(pathOffsetMemoryKey, true);

  const timeout = useRef<Timeout>();

  useEffect(() => {
    const recurUntilRef = () => {
      setTimeout(() => {
        const path = pathRef.current;
        if (path) setPathLength(path.getTotalLength() || 700);
        else recurUntilRef();
      }, 100);
    };

    recurUntilRef();

    if (!transitioning) {
      clearTimeout(timeout.current);
      timeout.current = setTimeout(() => setPathOffset(false), 300);
    }
  }, [transitioning, setPathLength, setPathOffset]);

  const divRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const height = 100;

  const observerRef = useRef(
    new ResizeObserver((entries) => {
      const element = entries[0];
      const { width } = element.contentRect;
      setWidth(width);
    })
  );

  useEffect(() => {
    const div = divRef.current;
    const observer = observerRef.current;
    if (div) observer.observe(div);

    return () => {
      if (div) observer.unobserve(div);
    };
  }, []);

  const d = points
    .flatMap((e, i) => {
      const x = e[0] * (width - 10) + 5;
      const y = (1 - e[1]) * (height - 10) + 5;
      if (!i) return [`M${x},${y}`];
      if (type === "diagonal") return [`${x},${y}`];
      const _x = points[i - 1][0] * (width - 10) + 5;
      return [`${_x},${y}`, `${x},${y}`];
    })
    .join(" ");

  const classes = ["Line"];
  if (color.split("").reduce((a, e, i, t) => (i < 2 ? a : a || e !== t[i - 1]), false)) {
    classes.push("colored");
  }
  return (
    <div ref={divRef} className={classes.join(" ")} style={{ width: "100%" }}>
      <svg
        height="100%"
        width="100%"
        viewBox={`0 0 ${width} 100`}
        preserveAspectRatio="none"
      >
        <path
          ref={pathRef}
          d={width ? d : ""}
          style={{
            display: pathLength ? "block" : "none",
            stroke: color,
            strokeDasharray: pathLength + 5,
            strokeDashoffset: pathOffset ? pathLength + 5 : 0,
            transition: "stroke-dashoffset 1s ease 0s",
            strokeWidth: 3,
            strokeLinecap: "round",
            strokeLinejoin: "round",
            fill: "none",
          }}
        />
      </svg>
    </div>
  );
};

export default Line;
