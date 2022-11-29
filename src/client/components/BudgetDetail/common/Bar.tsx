import { useState, useEffect, DetailedHTMLProps, HTMLAttributes, useRef } from "react";
import { useAppContext } from "client";

type Props = { ratio: number; unlabledRatio?: number } & DetailedHTMLProps<
  HTMLAttributes<HTMLDivElement>,
  HTMLDivElement
>;

const Bar = ({ ratio, unlabledRatio, className, ...rest }: Props) => {
  const { router } = useAppContext();
  const { transitioning } = router.transition;

  const [numeratorWidth, setNumeratorWidth] = useState(0);
  const [unlabeledNumeratorWidth, setUnlabeledNumeratorWidth] = useState(0);
  const [overflowedNumeratorWidth, setOverflowedNumeratorWidth] = useState(0);

  useEffect(() => {
    if (!transitioning) {
      setNumeratorWidth(ratio * 100);
      setUnlabeledNumeratorWidth((unlabledRatio || 0) * 100);
    }
    return () => {
      setNumeratorWidth(0);
      setUnlabeledNumeratorWidth(0);
    };
  }, [ratio, unlabledRatio, transitioning]);

  const isOverCapped = ratio + (unlabledRatio || 0) > 1;
  const overflowedRatio = Math.max(ratio + (unlabledRatio || 0) - 1, 0);
  const alertClass = isOverCapped ? "alert" : "";

  type SetTimeout = typeof setTimeout;
  type Timeout = ReturnType<SetTimeout>;

  const timeout = useRef<Timeout>();

  useEffect(() => {
    if (numeratorWidth + unlabeledNumeratorWidth >= 100) {
      clearTimeout(timeout.current);
      timeout.current = setTimeout(() => {
        setOverflowedNumeratorWidth(Math.min(1, overflowedRatio) * 100);
      }, 500);
    }
    return () => {
      setOverflowedNumeratorWidth(0);
    };
  }, [numeratorWidth, unlabeledNumeratorWidth, overflowedRatio]);

  return (
    <div {...rest} className={[className || "", "Bar", alertClass].join(" ")}>
      <div className="contentWithoutPadding">
        <div
          style={{
            display: numeratorWidth >= 100 ? "none" : "block",
            left: `calc(${numeratorWidth}% - 10px)`,
            width: unlabeledNumeratorWidth && `calc(${unlabeledNumeratorWidth}% + 10px)`,
          }}
          className={["unlabeledNumerator", "colored", alertClass].join(" ")}
        />
        <div
          style={{
            width: Math.min(100, numeratorWidth) + "%",
          }}
          className={["numerator", "colored", alertClass].join(" ")}
        />
        <div
          style={{
            width: Math.min(100, overflowedNumeratorWidth) + "%",
          }}
          className={[
            "overflowedNumerator",
            "colored",
            overflowedRatio > 1 ? alertClass : "",
          ].join(" ")}
        />
      </div>
    </div>
  );
};

export default Bar;
