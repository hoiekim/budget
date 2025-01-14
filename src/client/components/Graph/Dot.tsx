import { useEffect, useRef } from "react";
import { useAppContext, useDebounce, useMemoryState } from "client";
import { Point } from "./index";

interface Props {
  point: Point;
  color: string;
  memoryKey?: string;
}

const Dot = ({ memoryKey, point, color }: Props) => {
  const { router } = useAppContext();
  const { transitioning } = router.transition;
  const animateMemoryKey = memoryKey && `graphDot_${memoryKey}_opacity`;
  const [opacity, setOpacity] = useMemoryState(animateMemoryKey, 0);
  const [width, setWidth] = useMemoryState("graph_svgWidth", 0);

  const opacityDebouncer = useDebounce();

  useEffect(() => {
    if (!transitioning) opacityDebouncer(() => setOpacity(1), 1150);
  }, [point, transitioning, setOpacity, opacityDebouncer]);

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

  const x = point[0] * (width - 10) + 5;
  const y = (1 - point[1]) * (height - 10) + 5;

  const classes = ["Area"];
  const isColored = new Set(color.split("")).size > 2;
  if (isColored) classes.push("colored");

  return (
    <div ref={divRef} className={classes.join(" ")} style={{ width: "100%" }}>
      <svg height="100%" width="100%" viewBox={`0 0 ${width} 100`} preserveAspectRatio="none">
        <circle
          cx={x}
          cy={y}
          r="2"
          style={{
            stroke: color,
            strokeWidth: "4px",
            transition: "all 300ms ease 0s",
            opacity,
          }}
        />
      </svg>
    </div>
  );
};

export default Dot;
