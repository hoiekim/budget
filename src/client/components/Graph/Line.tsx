import { useEffect, useRef, useState } from "react";
import { Point } from "./index";

interface Props {
  points: Point[];
}

const Line = ({ points }: Props) => {
  const divRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(300);
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
      const x = e[0] * width;
      const y = (1 - e[1]) * height;
      const joinedCoordinate = `${x},${y}`;
      if (!i) return "M" + joinedCoordinate;
      return joinedCoordinate;
    })
    .join(" ");

  return (
    <div ref={divRef} className="Line">
      {divRef.current && (
        <svg
          height="100%"
          width="100%"
          viewBox={`0 0 ${width} 100`}
          preserveAspectRatio="none"
          className="colored"
        >
          <path
            d={d}
            style={{
              stroke: "#097",
              strokeWidth: 5,
              strokeLinecap: "round",
              strokeLinejoin: "round",
              fill: "none",
            }}
          />
        </svg>
      )}
    </div>
  );
};

export default Line;
