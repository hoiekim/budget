import { DetailedHTMLProps, HTMLAttributes } from "react";
import "./index.css";

export interface DonutData {
  id: string;
  value: number;
  valueAdjustment?: number;
  color?: string;
  label?: string;
}

type Props = {
  data: DonutData[];
  radius?: number;
  thickness?: number;
} & DetailedHTMLProps<HTMLAttributes<HTMLDivElement>, HTMLDivElement>;

const Donut = ({ data, radius = 100, thickness = 20, ...rest }: Props) => {
  // validate if the items are all positive or all negative.
  const isDataValid = !data.find(({ value }, i) => value * (data[i + 1]?.value || value) < 0);
  const total = data.reduce((acc, item) => acc + Math.abs(item.value), 0);
  const circumference = 2 * Math.PI * radius;
  let cumulativeOffset = 0;

  return (
    <div className="Donut colored" {...rest}>
      <svg width={2 * (radius + thickness)} height={2 * (radius + thickness)}>
        {isDataValid &&
          data.map((item, index) => {
            const _total = total || data.length;
            const itemValue = total ? item.value : 1;
            const segmentValue = (itemValue / _total) * circumference;
            const strokeDasharray = `${segmentValue} ${circumference}`;
            const strokeDashoffset = cumulativeOffset;

            cumulativeOffset -= segmentValue;

            return (
              <circle
                key={index}
                cx={radius + thickness}
                cy={radius + thickness}
                r={radius}
                fill="transparent"
                stroke={item.color}
                strokeWidth={thickness}
                strokeDasharray={strokeDasharray}
                strokeDashoffset={strokeDashoffset}
                transform={`rotate(-90 ${radius + thickness} ${radius + thickness})`}
              />
            );
          })}
      </svg>
    </div>
  );
};

export default Donut;
