import { useState, useEffect, DetailedHTMLProps, HTMLAttributes } from "react";

type Props = { ratio: number; unlabledRatio?: number } & DetailedHTMLProps<
  HTMLAttributes<HTMLDivElement>,
  HTMLDivElement
>;

const Bar = ({ ratio, unlabledRatio, className, ...rest }: Props) => {
  const [numeratorWidth, setNumeratorWidth] = useState(0);
  const [unlabeledNumeratorWidth, setUnlabeledNumeratorWidth] = useState(0);

  useEffect(() => {
    setNumeratorWidth(ratio * 100);
    setUnlabeledNumeratorWidth(Math.min(1, unlabledRatio || 0) * 100);
    return () => {
      setNumeratorWidth(0);
      setUnlabeledNumeratorWidth(0);
    };
  }, [ratio, unlabledRatio]);

  const overCapped = ratio + (unlabledRatio || 0) >= 1;
  const alertClass = overCapped ? "alert" : "";

  return (
    <div {...rest} className={[className || "", "Bar", alertClass].join(" ")}>
      <div className="contentWithoutPadding">
        <div
          style={{
            left: `calc(${numeratorWidth}% - 10px)`,
            width: `calc(${unlabeledNumeratorWidth}% + 10px)`,
          }}
          className={["unlabeledNumerator", "colored", alertClass].join(" ")}
        />
        <div
          style={{
            width:
              Math.min(
                100,
                numeratorWidth > 100 ? numeratorWidth - 100 : numeratorWidth
              ) + "%",
          }}
          className={["numerator", "colored", alertClass].join(" ")}
        />
      </div>
    </div>
  );
};

export default Bar;
