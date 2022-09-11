import { useState, useEffect, DetailedHTMLProps, HTMLAttributes } from "react";

type Props = { ratio: number; unlabledRatio?: number } & DetailedHTMLProps<
  HTMLAttributes<HTMLDivElement>,
  HTMLDivElement
>;

const Bar = ({ ratio, unlabledRatio, className, ...rest }: Props) => {
  const [numeratorWidth, setNumeratorWidth] = useState(0);
  const [unlabeledNumeratorWidth, setUnlabeledNumeratorWidth] = useState(0);

  useEffect(() => {
    setNumeratorWidth(Math.min(1, ratio) * 100);
    setUnlabeledNumeratorWidth(Math.min(1, unlabledRatio || 0) * 100);
    return () => {
      setNumeratorWidth(0);
      setUnlabeledNumeratorWidth(0);
    };
  }, [ratio, unlabledRatio]);

  return (
    <div {...rest} className={className ? className + " Bar" : "Bar"}>
      <div className="contentWithoutPadding">
        <div
          style={{
            left: `calc(${numeratorWidth}% - 10px)`,
            width: `calc(${unlabeledNumeratorWidth}% + 10px)`,
          }}
          className="unlabeledNumerator colored"
        />
        <div style={{ width: numeratorWidth + "%" }} className="numerator colored" />
      </div>
    </div>
  );
};

export default Bar;
