import { useEffect, useRef, useState } from "react";
import { useAppContext } from "client";
import { Timeout } from "common";
import { Point } from "./index";

interface Props {
  points: Point[];
}

const Line = ({ points }: Props) => {
  const { router } = useAppContext();
  const { transitioning } = router.transition;

  const pathRef = useRef<SVGPathElement>(null);
  const [pathLength, setPathLength] = useState(0);
  const [pathOffset, setPathOffset] = useState(true);

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
  }, [transitioning]);

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
    .map((e, i) => {
      const x = e[0] * (width - 10) + 5;
      const y = (1 - e[1]) * (height - 10) + 5;
      const joinedCoordinate = `${x},${y}`;
      if (!i) return "M" + joinedCoordinate;
      return joinedCoordinate;
    })
    .join(" ");

  return (
    <div ref={divRef} className="Line colored" style={{ width: "100%" }}>
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
            stroke: "#097",
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
