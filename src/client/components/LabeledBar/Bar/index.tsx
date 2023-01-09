import { useState, useEffect, DetailedHTMLProps, HTMLAttributes, useRef } from "react";
import { useAppContext } from "client";
import "./index.css";

type Props = { ratio?: number; unlabledRatio?: number } & DetailedHTMLProps<
  HTMLAttributes<HTMLDivElement>,
  HTMLDivElement
>;

const Bar = ({ ratio, unlabledRatio, className, ...rest }: Props) => {
  const { router } = useAppContext();
  const { transitioning } = router.transition;

  const [numeratorWidth, setNumeratorWidth] = useState(0);
  const [unlabeledNumeratorWidth, setUnlabeledNumeratorWidth] = useState(0);
  const [overflowFillerWidth, setOverflowFillerWidth] = useState(0);

  const definedRatio = ratio || 0;
  const definedUnlabeledRatio = unlabledRatio || 0;

  const isOverCapped = definedRatio + definedUnlabeledRatio > 1;
  const isOverCappedTwice = definedRatio + definedUnlabeledRatio > 2;
  const alertClass = isOverCapped ? (isOverCappedTwice ? "alert more" : "alert") : "";

  const classes = ["Bar", alertClass];
  if (className) classes.push(className);
  if (ratio === undefined && unlabledRatio === undefined) classes.push("empty");

  type SetTimeout = typeof setTimeout;
  type Timeout = ReturnType<SetTimeout>;
  const timeout = useRef<Timeout>();

  useEffect(() => {
    if (!transitioning) {
      if (isOverCapped) {
        const setNumeratorsWidths = () => {
          if (definedRatio > 1) {
            if (definedRatio > 2) {
              setNumeratorWidth(100);
              setUnlabeledNumeratorWidth(0);
            } else {
              const reducedRatio = definedRatio - 1;
              setNumeratorWidth(reducedRatio * 100);
              setUnlabeledNumeratorWidth(
                Math.min(definedUnlabeledRatio, 1 - reducedRatio) * 100
              );
            }
          } else {
            setNumeratorWidth(0);
            const reducedUnlabeledRatio = definedUnlabeledRatio - (1 - definedRatio);
            setUnlabeledNumeratorWidth(Math.min(1, reducedUnlabeledRatio) * 100);
          }
        };

        setOverflowFillerWidth((oldValue) => {
          if (oldValue === 100) {
            setNumeratorsWidths();
          } else {
            setOverflowFillerWidth(100);
            clearTimeout(timeout.current);
            timeout.current = setTimeout(setNumeratorsWidths, 500);
          }
          return oldValue;
        });
      } else {
        setOverflowFillerWidth((oldValue) => {
          if (oldValue) {
            setNumeratorWidth(0);
            setUnlabeledNumeratorWidth(0);
            clearTimeout(timeout.current);
            timeout.current = setTimeout(() => {
              setOverflowFillerWidth(0);
              clearTimeout(timeout.current);
              timeout.current = setTimeout(() => {
                setNumeratorWidth(definedRatio * 100);
                setUnlabeledNumeratorWidth(definedUnlabeledRatio * 100);
              }, 500);
            }, 500);
          } else {
            setNumeratorWidth(definedRatio * 100);
            setUnlabeledNumeratorWidth(definedUnlabeledRatio * 100);
          }
          return oldValue;
        });
      }
    }
  }, [definedRatio, definedUnlabeledRatio, isOverCapped, transitioning]);

  return (
    <div {...rest} className={classes.join(" ")}>
      <div className="contentWithoutPadding">
        <div
          style={{
            width: Math.min(100, overflowFillerWidth) + "%",
          }}
          className={["overflowFiller", "colored", alertClass].join(" ")}
        />
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
      </div>
    </div>
  );
};

export default Bar;
