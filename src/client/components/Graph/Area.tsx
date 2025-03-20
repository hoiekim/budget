import { useEffect, useRef } from "react";
import { useAppContext, useDebounce, useMemoryState } from "client";
import { LineType, Point, pointsToCoordinateString } from "./lib";

interface Props {
  upperBound: (Point | undefined)[];
  lowerBound: (Point | undefined)[];
  color: string;
  type?: LineType;
  memoryKey?: string;
  height?: number;
}

const Area = ({
  memoryKey,
  upperBound,
  lowerBound,
  color,
  type = "diagonal",
  height = 100,
}: Props) => {
  const { router } = useAppContext();
  const { transitioning } = router.transition;
  const animateMemoryKey = memoryKey && `graphArea_${memoryKey}_animate`;
  const [animate, setAnimate] = useMemoryState(animateMemoryKey, true);
  const [width, setWidth] = useMemoryState("graph_svgWidth", 0);
  const [isVisible, setIsVisible] = useMemoryState("graphArea_isVisible", false);

  const visibleDebouncer = useDebounce();
  const animateDebouncer = useDebounce();

  useEffect(() => {
    if (!transitioning) visibleDebouncer(() => setIsVisible(true), 100);
  }, [upperBound, lowerBound, transitioning, setIsVisible, visibleDebouncer]);

  useEffect(() => {
    if (isVisible) animateDebouncer(() => setAnimate(false), 1300);
  }, [isVisible, setAnimate, animateDebouncer]);

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

  const translate = (points: (Point | undefined)[]) => {
    return pointsToCoordinateString(points, width, height, type);
  };

  const translatedPoints = [...translate(upperBound), ...translate(lowerBound).reverse()];
  const d = "M" + translatedPoints.join(" ");

  const isColored = new Set(color.split("")).size > 2;

  return (
    <div ref={divRef} className="Area" style={{ width: "100%" }}>
      {isVisible && (
        <svg
          className={isColored ? "colored" : undefined}
          height="100%"
          width="100%"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          style={{ color }}
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
                begin="0"
                repeatCount="0"
                fill="freeze"
              />
            </stop>
            <stop offset="100%" stopColor="white" stopOpacity="0" />
          </linearGradient>
          <mask id="prog-render">
            <rect x="0" y="0" width="100%" height="100%" fill="url(#prog-mask)" />
          </mask>
          <pattern id="pattern" x="0" y="0" width="4" height="4" patternUnits="userSpaceOnUse">
            <path d="M-1,1 l2,-2 M0,4 l4,-4 M3,5 l2,-2" style={{ stroke: "currentcolor" }} />
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
      )}
    </div>
  );
};

export default Area;
