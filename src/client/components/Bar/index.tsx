import { useEffect, DetailedHTMLProps, HTMLAttributes, useRef } from "react";
import { useAppContext, useMemoryState } from "client";
import { Timeout, clamp } from "common";
import "./index.css";

type Props = {
  memoryKey?: string;
  ratio?: number;
  unlabeledRatio?: number;
  noAlert?: boolean;
} & DetailedHTMLProps<HTMLAttributes<HTMLDivElement>, HTMLDivElement>;

const Bar = ({
  memoryKey,
  ratio,
  unlabeledRatio,
  noAlert,
  className,
  ...rest
}: Props) => {
  const { router } = useAppContext();
  const { transitioning } = router.transition;

  const memoryKey0 = memoryKey && `bar_${memoryKey}_0`;
  const [barWidth, setBarWidth] = useMemoryState(memoryKey0, 0);
  const memoryKey1 = memoryKey && `bar_${memoryKey}_1`;
  const [dottedBarWidth, setDottedBarWidth] = useMemoryState(memoryKey1, 0);
  const memoryKey2 = memoryKey && `bar_${memoryKey}_2`;
  const [fillerWidth, setFillerWidth] = useMemoryState(memoryKey2, 0);
  const memoryKey3 = memoryKey && `bar_${memoryKey}_3`;
  const [alertLevel, setAlertLevel] = useMemoryState(memoryKey3, 0);

  const definedRatio = ratio || 0;
  const definedUnlabeledRatio = unlabeledRatio || 0;

  const isOverCapped = !noAlert && definedRatio + definedUnlabeledRatio > 1;
  const isOverCappedTwice = !noAlert && definedRatio + definedUnlabeledRatio > 2;

  const barColorTransitionTimeout = useRef<Timeout>();

  useEffect(() => {
    if (!transitioning) {
      clearTimeout(barColorTransitionTimeout.current);
      barColorTransitionTimeout.current = setTimeout(() => {
        setAlertLevel(isOverCapped ? (isOverCappedTwice ? 2 : 1) : 0);
      }, 500);
    }
  }, [transitioning, isOverCapped, isOverCappedTwice, setAlertLevel]);

  const alertClasses = [];
  if (alertLevel > 0) alertClasses.push("alert");
  if (alertLevel > 1) alertClasses.push("more");

  const classes = ["Bar", ...alertClasses];
  if (className) classes.push(className);
  if (ratio === undefined && unlabeledRatio === undefined) classes.push("empty");

  const barMovingTimeout = useRef<Timeout>();

  useEffect(() => {
    if (!transitioning) {
      if (isOverCapped) {
        const setBarsWidths = () => {
          if (definedRatio > 1) {
            if (definedRatio > 2) {
              setBarWidth(100);
              setDottedBarWidth(0);
            } else {
              const reducedRatio = definedRatio - 1;
              setBarWidth(reducedRatio * 100);
              setDottedBarWidth(Math.min(definedUnlabeledRatio, 1 - reducedRatio) * 100);
            }
          } else {
            setBarWidth(0);
            const reducedUnlabeledRatio = definedUnlabeledRatio - (1 - definedRatio);
            setDottedBarWidth(clamp(reducedUnlabeledRatio, 0, 1) * 100);
          }
        };

        const setAllWidths = () => {
          setFillerWidth((oldFillerWidth) => {
            const wasOverCapped = oldFillerWidth === 100;
            if (wasOverCapped) {
              setBarsWidths();
            } else {
              setFillerWidth(100);
              clearTimeout(barMovingTimeout.current);
              barMovingTimeout.current = setTimeout(setBarsWidths, 500);
            }
            return 100;
          });
        };

        setBarWidth((oldBarWidth) => {
          setDottedBarWidth((oldDottedBarWidth) => {
            if (!oldBarWidth && !oldDottedBarWidth) {
              setAllWidths();
            } else {
              clearTimeout(barMovingTimeout.current);
              barMovingTimeout.current = setTimeout(setAllWidths, 500);
            }
            return 0;
          });
          return 0;
        });
      } else {
        const setBarsWidths = () => {
          setBarWidth(clamp(definedRatio, 0, 1) * 100);
          setDottedBarWidth(clamp(definedUnlabeledRatio, 0, 1) * 100);
        };

        setFillerWidth((oldFillerWidth) => {
          const wasOverCapped = oldFillerWidth === 100;
          if (wasOverCapped) {
            setBarWidth(0);
            setDottedBarWidth(0);
            clearTimeout(barMovingTimeout.current);
            barMovingTimeout.current = setTimeout(() => {
              setFillerWidth(0);
              clearTimeout(barMovingTimeout.current);
              barMovingTimeout.current = setTimeout(setBarsWidths, 500);
            }, 500);
          } else {
            setBarsWidths();
          }

          return oldFillerWidth;
        });
      }
    }
  }, [
    definedRatio,
    definedUnlabeledRatio,
    isOverCapped,
    transitioning,
    setBarWidth,
    setDottedBarWidth,
    setFillerWidth,
  ]);

  return (
    <div {...rest} className={classes.join(" ")}>
      <div className="contentWithoutPadding">
        <div
          style={{ width: Math.min(100, fillerWidth) + "%" }}
          className={["overflowFiller", "colored", ...alertClasses].join(" ")}
        />
        <div
          style={{
            display: barWidth >= 100 ? "none" : "block",
            left: 0,
            width: barWidth + dottedBarWidth + "%",
          }}
          className={["unlabeledNumerator", "colored", ...alertClasses].join(" ")}
        />
        <div
          style={{ width: Math.min(100, barWidth) + "%" }}
          className={["numerator", "colored", ...alertClasses].join(" ")}
        />
      </div>
    </div>
  );
};

export default Bar;
