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

export const Bar = ({
  memoryKey,
  ratio: _ratio,
  unlabeledRatio: _unlabeledRatio,
  noAlert,
  className,
  ...rest
}: Props) => {
  const { router } = useAppContext();
  const { transitioning } = router.transition;

  const primaryBarKey = memoryKey && `bar_${memoryKey}_primary`;
  const [primaryBarWidth, setPrimaryBarWidth] = useMemoryState(primaryBarKey, 0);
  const secondaryBarKey = memoryKey && `bar_${memoryKey}_secondary`;
  const [secondaryBarWidth, setSecondaryBarWidth] = useMemoryState(secondaryBarKey, 0);
  const primaryDottedBarKey = memoryKey && `bar_${memoryKey}_dotted_primary`;
  const [primaryDottedBarWidth, setPrimaryDottedBarWidth] = useMemoryState(primaryDottedBarKey, 0);
  const secondaryDottedBarKey = memoryKey && `bar_${memoryKey}_dotted_secondary`;
  const [secondaryDottedBarWidth, setSecondaryDottedBarWidth] = useMemoryState(
    secondaryDottedBarKey,
    0
  );
  const alertLevelKey = memoryKey && `bar_${memoryKey}_alertLevel`;
  const [alertLevel, setAlertLevel] = useMemoryState(alertLevelKey, 0);

  const isEmpty = _ratio === undefined && _unlabeledRatio === undefined;
  const ratio = Math.max(_ratio || 0, 0);
  const unlabeledRatio = Math.max(_unlabeledRatio || 0, 0);
  const totalRatio = ratio + unlabeledRatio;

  const barColorTransitionTimeout = useRef<Timeout>();

  useEffect(() => {
    if (!transitioning) {
      clearTimeout(barColorTransitionTimeout.current);
      barColorTransitionTimeout.current = setTimeout(() => {
        const newAlertLevel = noAlert ? 0 : Math.floor(totalRatio);
        if (newAlertLevel === 2) {
          setAlertLevel(1);
          setTimeout(() => setAlertLevel(2), 500);
        } else {
          setAlertLevel(newAlertLevel);
        }
      }, 500);
    }
  }, [transitioning, noAlert, totalRatio, setAlertLevel]);

  const alertClasses = [];
  if (alertLevel > 0) alertClasses.push("alert");
  if (alertLevel > 1) alertClasses.push("more");

  const classes = ["Bar", ...alertClasses];
  if (className) classes.push(className);
  if (isEmpty) classes.push("empty");

  const barMovingTimeout = useRef<Timeout>();

  useEffect(() => {
    if (!transitioning) {
      if (totalRatio > 1) {
        const setBars = () => {
          const reducedRatio = clamp(ratio - 1, 0, 1);
          setSecondaryBarWidth(reducedRatio * 100);
          const reducedUnlabeled = clamp(Math.min(ratio - 1, 0) + unlabeledRatio, 0, 1);
          setSecondaryDottedBarWidth(reducedUnlabeled * 100);
        };

        setPrimaryBarWidth((oldPrimaryBarWidth) => {
          if (oldPrimaryBarWidth === 100) setBars();
          else barMovingTimeout.current = setTimeout(setBars, 500);
          return 100;
        });
        setPrimaryDottedBarWidth(0);
      } else {
        const setBars = () => {
          setPrimaryBarWidth(ratio * 100);
          setPrimaryDottedBarWidth(unlabeledRatio * 100);
        };

        setSecondaryBarWidth((oldSecondaryBarWidth) => {
          setSecondaryDottedBarWidth((oldSecondaryDottedBarWidth) => {
            if (!oldSecondaryBarWidth && !oldSecondaryDottedBarWidth) setBars();
            else barMovingTimeout.current = setTimeout(setBars, 500);
            return 0;
          });
          return 0;
        });
      }
    }
  }, [
    ratio,
    unlabeledRatio,
    totalRatio,
    transitioning,
    setSecondaryBarWidth,
    setSecondaryDottedBarWidth,
    setPrimaryDottedBarWidth,
    setPrimaryBarWidth,
  ]);

  return (
    <div {...rest} className={classes.join(" ")}>
      <div className="contentWithoutPadding">
        <div
          style={{ width: primaryBarWidth + primaryDottedBarWidth + "%" }}
          className={["primaryDottedNumerator", "colored", ...alertClasses].join(" ")}
        />
        <div
          style={{ width: primaryBarWidth + "%" }}
          className={["primaryNumerator", "colored", ...alertClasses].join(" ")}
        />
        <div
          style={{ width: secondaryBarWidth + secondaryDottedBarWidth + "%" }}
          className={["secondaryDottedNumerator", "colored", ...alertClasses].join(" ")}
        />
        <div
          style={{ width: secondaryBarWidth + "%" }}
          className={["secondaryNumerator", "colored", ...alertClasses].join(" ")}
        />
      </div>
    </div>
  );
};
