import { ChangeEventHandler, useState } from "react";
import { ChartType } from "common";
import {
  Chart,
  BalanceChart,
  ProjectionChart,
  FlowChart,
  useMutate,
  getChartTypeName,
  KeyValue,
} from "client";

interface Props {
  chart: BalanceChart | ProjectionChart | FlowChart;
}

export const ChartTypeSelect = ({ chart }: Props) => {
  const [selectedType, setSelectedType] = useState<ChartType>(chart.type);
  const mutate = useMutate(Chart);

  const onChange: ChangeEventHandler<HTMLSelectElement> = (e) => {
    const newType = e.target.value as ChartType;
    setSelectedType(newType);
    mutate.update(new Chart({ ...chart, type: newType }));
  };

  return (
    <KeyValue name="Chart&nbsp;Type">
      <select value={selectedType} onChange={onChange}>
        {Object.values(ChartType).map((v) => (
          <option key={`chart_type_option_${v}`} value={v}>
            {getChartTypeName(v)}
          </option>
        ))}
      </select>
    </KeyValue>
  );
};
