import { useEffect, useRef } from "react";
import { useAppContext, useDebounce, useMemoryState } from "client";
import { LineType, Point, pointsToCoordinateString } from "./lib";

interface Props {
  points: (Point | undefined)[];
  color: string;
  type?: LineType;
  strokeType?: "solid" | "dashed";
  memoryKey?: string;
  height?: number;
}

const Line = ({
  memoryKey,
  points,
  color,
  type = "diagonal",
  strokeType = "solid",
  height = 100,
}: Props) => {
  const { router } = useAppContext();
  const { transitioning } = router.transition;

  const pathRef = useRef<SVGPathElement>(null);
  const pathLengthMemoryKey = memoryKey && `graphLine_${memoryKey}_pathLength`;
  const [pathLength, setPathLength] = useMemoryState(pathLengthMemoryKey, 0);
  const pathOffsetMemoryKey = memoryKey && `graphLine_${memoryKey}_pathOffset`;
  const [pathOffset, setPathOffset] = useMemoryState(pathOffsetMemoryKey, true);
  const strokeDashArrayMemoryKey = memoryKey && `graphLine_${memoryKey}_strokeDashArray`;
  const [strokeDashArray, setStrokeDashArray] = useMemoryState(strokeDashArrayMemoryKey, "5");
  const [width, setWidth] = useMemoryState("graph_svgWidth", 0);

  const pathDebouncer = useDebounce();
  const offsetDebouncer = useDebounce();

  useEffect(() => {
    const recurUntilRef = () => {
      const path = pathRef.current;
      if (!path) {
        setTimeout(recurUntilRef, 100);
        return;
      }

      pathDebouncer(() => {
        const newPathLength = path.getTotalLength() || 700;
        setPathLength(newPathLength);
        if (strokeType === "solid") {
          setStrokeDashArray((newPathLength + 5).toString());
        } else {
          const dashArray: number[] = [];
          for (let i = 0; i < Math.floor(newPathLength / 8); i++) {
            dashArray.push(1);
            dashArray.push(7);
          }
          dashArray.push(1, (newPathLength % 8) - 1 + newPathLength + 5);
          setStrokeDashArray(dashArray.join(" "));
        }
      }, 110);

      if (!transitioning) {
        offsetDebouncer(() => {
          setPathOffset(false);
        }, 300);
      }
    };

    setTimeout(recurUntilRef, 100);
  }, [
    points,
    transitioning,
    setPathLength,
    setPathOffset,
    pathDebouncer,
    offsetDebouncer,
    setStrokeDashArray,
    strokeType,
  ]);

  const divRef = useRef<HTMLDivElement>(null);

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

  const coordinateStrings = pointsToCoordinateString(points, width, height, type);
  const d = "M" + coordinateStrings.join(" ");

  const classes = ["Line"];
  const isColored = new Set(color.split("")).size > 2;
  if (isColored) classes.push("colored");

  return (
    <div ref={divRef} className={classes.join(" ")} style={{ width: "100%" }}>
      <svg height="100%" width="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <path
          ref={pathRef}
          d={width ? d : ""}
          style={{
            display: pathLength ? "block" : "none",
            stroke: color,
            strokeDasharray: strokeDashArray,
            strokeDashoffset: pathOffset ? pathLength + 5 : 0,
            transition: "all 1s ease 0s",
            strokeWidth: 2,
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
