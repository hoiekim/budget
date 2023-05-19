import { useEffect, useRef } from "react";
import { useAppContext, useMemoryState } from "client";
import { Timeout } from "common";
import { LineType, Point } from "./index";

interface Props {
  upperBound: (Point | undefined)[];
  lowerBound: (Point | undefined)[];
  color: string;
  type?: LineType;
  memoryKey?: string;
}

const Area = ({ memoryKey, upperBound, lowerBound, color, type = "diagonal" }: Props) => {
  const { router } = useAppContext();
  const { transitioning } = router.transition;
  const opacityMemoryKey = memoryKey && `graphLine_${memoryKey}_opacity`;
  const [opacity, setOpacity] = useMemoryState(opacityMemoryKey, 0);
  const [width, setWidth] = useMemoryState("graphLine_svgWidth", 0);

  const timeout = useRef<Timeout>();

  useEffect(() => {
    if (!transitioning) {
      clearTimeout(timeout.current);
      timeout.current = setTimeout(() => setOpacity(0.5), 600);
    }
  }, [transitioning, setOpacity]);

  const divRef = useRef<HTMLDivElement>(null);
  const height = 100;

  const observerRef = useRef(
    new ResizeObserver((entries) => {
      const element = entries[0];
      setWidth(element.contentRect.width);
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

  const translate = (points: (Point | undefined)[]) => {
    return points.flatMap((e, i) => {
      if (!e) return [];
      const x = e[0] * (width - 10) + 5;
      const y = (1 - e[1]) * (height - 10) + 5;
      if (type === "diagonal") return [`${x},${y}`];
      const previousPoint = points[i - 1];
      if (previousPoint === undefined) return [`${x},${y}`];
      const _x = previousPoint[0] * (width - 10) + 5;
      return [`${_x},${y}`, `${x},${y}`];
    });
  };

  const translatedPoints = [...translate(upperBound), ...translate(lowerBound).reverse()];
  const d = "M" + translatedPoints.filter((e) => e).join(" ");

  const classes = ["Area"];
  const isColored = new Set(color.split("")).size > 2;
  if (isColored) classes.push("colored");

  return (
    <div ref={divRef} className={classes.join(" ")} style={{ width: "100%" }}>
      <svg
        height="100%"
        width="100%"
        viewBox={`0 0 ${width} 100`}
        preserveAspectRatio="none"
      >
        <pattern
          id="pattern"
          x="0"
          y="0"
          width="4"
          height="4"
          patternUnits="userSpaceOnUse"
        >
          <path d="M-1,1 l2,-2 M0,4 l4,-4 M3,5 l2,-2" style={{ stroke: color }} />
        </pattern>
        <path
          d={width ? d : ""}
          style={{
            transition: "all 1s ease 0s",
            strokeLinecap: "round",
            strokeLinejoin: "round",
            fill: "url(#pattern)",
            opacity,
          }}
        />
      </svg>
    </div>
  );
};

export default Area;
