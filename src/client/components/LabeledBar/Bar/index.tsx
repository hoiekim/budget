import { useState, useEffect, DetailedHTMLProps, HTMLAttributes, useRef } from "react";
import { useAppContext, Timeout, clamp } from "client";
import "./index.css";

type Props = {
  ratio?: number;
  unlabledRatio?: number;
  noAlert?: boolean;
} & DetailedHTMLProps<HTMLAttributes<HTMLDivElement>, HTMLDivElement>;

const Bar = ({
  ratio,
  unlabledRatio: unlabeledRatio,
  noAlert,
  className,
  ...rest
}: Props) => {
  const { router } = useAppContext();
  const { transitioning } = router.transition;

  const [numeratorWidth, setNumeratorWidth] = useState(0);
  const [unlabeledNumeratorWidth, setUnlabeledNumeratorWidth] = useState(0);
  const [overflowFillerWidth, setOverflowFillerWidth] = useState(0);
  const [alertLevel, setAlertLevel] = useState(0);

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
  }, [transitioning, isOverCapped, isOverCappedTwice]);

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
            setUnlabeledNumeratorWidth(clamp(reducedUnlabeledRatio, 0, 1) * 100);
          }
        };

        const setAllWidths = () => {
          setOverflowFillerWidth((oldOlverFlowFillerWidth) => {
            const wasOverCapped = oldOlverFlowFillerWidth === 100;
            if (wasOverCapped) {
              setNumeratorsWidths();
            } else {
              setOverflowFillerWidth(100);
              clearTimeout(barMovingTimeout.current);
              barMovingTimeout.current = setTimeout(setNumeratorsWidths, 500);
            }
            return oldOlverFlowFillerWidth;
          });
        };

        setNumeratorWidth((oldNumeratorWidth) => {
          setUnlabeledNumeratorWidth((oldUnlabledNumeratorWidth) => {
            if (!oldNumeratorWidth && !oldUnlabledNumeratorWidth) {
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
        const setNumeratorsWidths = () => {
          setNumeratorWidth(clamp(definedRatio, 0, 1) * 100);
          setUnlabeledNumeratorWidth(clamp(definedUnlabeledRatio, 0, 1) * 100);
        };

        setOverflowFillerWidth((oldOlverFlowFillerWidth) => {
          const wasOverCapped = oldOlverFlowFillerWidth === 100;
          if (wasOverCapped) {
            setNumeratorWidth(0);
            setUnlabeledNumeratorWidth(0);
            clearTimeout(barMovingTimeout.current);
            barMovingTimeout.current = setTimeout(() => {
              setOverflowFillerWidth(0);
              clearTimeout(barMovingTimeout.current);
              barMovingTimeout.current = setTimeout(setNumeratorsWidths, 500);
            }, 500);
          } else {
            setNumeratorsWidths();
          }

          return oldOlverFlowFillerWidth;
        });
      }
    }
  }, [definedRatio, definedUnlabeledRatio, isOverCapped, transitioning]);

  useEffect(
    () => () => {
      setNumeratorWidth(0);
      setUnlabeledNumeratorWidth(0);
      setOverflowFillerWidth(0);
      setAlertLevel(0);
    },
    []
  );

  return (
    <div {...rest} className={classes.join(" ")}>
      <div className="contentWithoutPadding">
        <div
          style={{ width: Math.min(100, overflowFillerWidth) + "%" }}
          className={["overflowFiller", "colored", ...alertClasses].join(" ")}
        />
        <div
          style={{
            display: numeratorWidth >= 100 ? "none" : "block",
            left: 0,
            width:
              unlabeledNumeratorWidth && numeratorWidth + unlabeledNumeratorWidth + "%",
          }}
          className={["unlabeledNumerator", "colored", ...alertClasses].join(" ")}
        />
        <div
          style={{ width: Math.min(100, numeratorWidth) + "%" }}
          className={["numerator", "colored", ...alertClasses].join(" ")}
        />
      </div>
    </div>
  );
};

export default Bar;
