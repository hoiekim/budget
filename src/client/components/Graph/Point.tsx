import { useEffect, useRef } from "react";
import { useAppContext, useMemoryState } from "client";
import { Timeout } from "common";
import { Point } from "./index";

interface Props {
  point: Point;
  color: string;
  memoryKey?: string;
}

const Area = ({ memoryKey, point, color }: Props) => {
  const { router } = useAppContext();
  const { transitioning } = router.transition;
  const animateMemoryKey = memoryKey && `graphLine_${memoryKey}_opacity`;
  const [opacity, setOpacity] = useMemoryState(animateMemoryKey, 0);
  const [width, setWidth] = useMemoryState("graphLine_svgWidth", 0);

  const timeout = useRef<Timeout>();

  useEffect(() => {
    if (!transitioning) {
      clearTimeout(timeout.current);
      timeout.current = setTimeout(() => setOpacity(1), 1000);
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

  const x = point[0] * (width - 10) + 5;
  const y = (1 - point[1]) * (height - 10) + 5;

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
        <circle
          cx={x}
          cy={y}
          r="5"
          style={{
            transition: "all 1s ease 0s",
            opacity,
          }}
        />
      </svg>
    </div>
  );
};

export default Area;
