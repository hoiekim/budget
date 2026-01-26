import { useEffect, useRef } from "react";
import { useAppContext, useDebounce, useMemoryState } from "client";
import { Point } from "./index";

interface Props {
  point: Point;
  color: string;
  guideX?: boolean;
  guideY?: boolean;
  memoryKey?: string;
  height?: number;
}

const Dot = ({ memoryKey, point, color, guideX, guideY, height = 100 }: Props) => {
  const { router } = useAppContext();
  const { transitioning } = router.transition;
  const animateMemoryKey = memoryKey && `graphDot_${memoryKey}_opacity`;
  const [opacity, setOpacity] = useMemoryState(animateMemoryKey, 0);
  const [width, setWidth] = useMemoryState(`graph_svgWidth_${memoryKey}`, 0);

  const opacityDebouncer = useDebounce();

  useEffect(() => {
    if (!transitioning) opacityDebouncer(() => setOpacity(1), 1150);
  }, [point, transitioning, setOpacity, opacityDebouncer]);

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

  const x = point[0] * (width - 10) + 5;
  const y = (1 - point[1]) * (height - 10) + 5;

  const isColored = new Set(color.split("")).size > 2;

  return (
    <div ref={divRef} className="Dot" style={{ width: "100%" }}>
      <svg
        className={isColored ? "colored" : undefined}
        height="100%"
        width="100%"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        style={{ color }}
      >
        <circle
          cx={x}
          cy={y}
          r="2"
          style={{
            stroke: "currentcolor",
            strokeWidth: "4px",
            transition: "all 300ms ease 0s",
            opacity,
          }}
        />
        {guideX && (
          <line
            x1={x}
            y1={5}
            x2={x}
            y2={height - 5}
            style={{
              stroke: "currentcolor",
              strokeWidth: "1px",
              transition: "all 300ms ease 0s",
              opacity: opacity * 0.5,
            }}
          />
        )}
        {guideY && (
          <line
            x1={5}
            y1={y}
            x2={width - 5}
            y2={y}
            style={{
              stroke: color,
              strokeWidth: "1px",
              transition: "all 300ms ease 0s",
              opacity: opacity * 0.5,
            }}
          />
        )}
      </svg>
    </div>
  );
};

export default Dot;
