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

  const definedRatio = ratio ? Math.max(ratio, 0) : 0;
  const definedUnlabeledRatio = unlabledRatio ? Math.max(unlabledRatio, 0) : 0;

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

        const setAllWidths = () => {
          setOverflowFillerWidth((oldOlverFlowFillerWidth) => {
            const wasOverCapped = oldOlverFlowFillerWidth === 100;
            if (wasOverCapped) {
              setNumeratorsWidths();
            } else {
              setOverflowFillerWidth(100);
              clearTimeout(timeout.current);
              timeout.current = setTimeout(setNumeratorsWidths, 500);
            }
            return oldOlverFlowFillerWidth;
          });
        };

        setNumeratorWidth((oldNumeratorWidth) => {
          setUnlabeledNumeratorWidth((oldUnlabledNumeratorWidth) => {
            if (!oldNumeratorWidth && !oldUnlabledNumeratorWidth) {
              setAllWidths();
            } else {
              clearTimeout(timeout.current);
              timeout.current = setTimeout(setAllWidths, 500);
            }
            return 0;
          });
          return 0;
        });
      } else {
        const setNumeratorsWidths = () => {
          setNumeratorWidth(definedRatio * 100);
          setUnlabeledNumeratorWidth(definedUnlabeledRatio * 100);
        };

        setOverflowFillerWidth((oldOlverFlowFillerWidth) => {
          const wasOverCapped = oldOlverFlowFillerWidth === 100;
          if (wasOverCapped) {
            setNumeratorWidth(0);
            setUnlabeledNumeratorWidth(0);
            clearTimeout(timeout.current);
            timeout.current = setTimeout(() => {
              setOverflowFillerWidth(0);
              clearTimeout(timeout.current);
              timeout.current = setTimeout(setNumeratorsWidths, 500);
            }, 500);
          } else {
            setNumeratorsWidths();
          }

          return oldOlverFlowFillerWidth;
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
