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
  const animateMemoryKey = memoryKey && `graphLine_${memoryKey}_opacity`;
  const [animate, setAnimate] = useMemoryState(animateMemoryKey, true);
  const [width, setWidth] = useMemoryState("graphLine_svgWidth", 0);

  const timeout = useRef<Timeout>();

  useEffect(() => {
    if (!transitioning) {
      clearTimeout(timeout.current);
      timeout.current = setTimeout(() => setAnimate(false), 1300);
    }
  }, [transitioning, setAnimate]);

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
        <linearGradient id="prog-mask" x1="0%" x2="0%" y1="100%" y2="100%">
          <stop offset="0%" stopColor="white" stopOpacity="1" />
          <stop offset="0%" stopColor="white" stopOpacity="1">
            <animate
              attributeName="offset"
              values="0; 1"
              dur="1s"
              begin="300ms"
              repeatCount="0"
              fill="freeze"
            />
          </stop>
          <stop offset="0%" stopColor="white" stopOpacity="0">
            <animate
              attributeName="offset"
              values="0; 1"
              dur="1s"
              begin="300ms"
              repeatCount="0"
              fill="freeze"
            />
          </stop>
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </linearGradient>
        <mask id="prog-render">
          <rect x="0" y="0" width="100%" height="100%" fill="url(#prog-mask)" />
        </mask>
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
            mask: animate ? "url(#prog-render)" : undefined,
            opacity: 0.5,
          }}
        />
      </svg>
    </div>
  );
};

export default Area;
