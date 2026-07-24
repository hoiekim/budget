import { ChangeEventHandler, MouseEventHandler, ReactNode, useState } from "react";
import {
  FlowChart,
  Chart,
  PATH,
  useAppContext,
  useDebounce,
  useMutate,
  DeleteButton,
  Properties,
  PropertyLabel,
  Property,
  Row,
  KeyValue,
  ChartTypeSelect,
} from "client";

interface FlowChartPropertiesProps {
  chart: FlowChart;
  children?: ReactNode;
}

export const FlowChartProperties = ({ chart, children }: FlowChartPropertiesProps) => {
  const { router } = useAppContext();
  const { name, chart_id, configuration } = chart;
  const { account_ids } = configuration;

  const { data } = useAppContext();
  const { accounts } = data;

  const [nameInput, setNameInput] = useState(name);

  const updateDebouncer = useDebounce();
  const mutate = useMutate(Chart);

  const updateChart = (updatedChart: Partial<Chart>) => {
    return mutate.update(new Chart({ ...chart, ...updatedChart }));
  };

  const onChangeName: ChangeEventHandler<HTMLInputElement> = (e) => {
    const newName = e.target.value;
    setNameInput(newName);
    updateDebouncer(() => updateChart({ name: newName }).catch(() => setNameInput(name)), 300);
  };

  const onClickAccounts: MouseEventHandler<HTMLButtonElement> = () => {
    router.go(PATH.CHART_ACCOUNTS, { params: new URLSearchParams({ chart_id }) });
  };

  const selectedAccountsCount = accounts.filter((a) => {
    return !a.hide && account_ids.includes(a.id);
  }).length;

  const onClickRemove: MouseEventHandler<HTMLButtonElement> = async () => {
    await mutate.delete(chart_id);
    router.back();
  };

  return (
    <Properties>
      <PropertyLabel>Chart&nbsp;Profile</PropertyLabel>
      <Property>
        <KeyValue name="Chart&nbsp;Name">
          <input value={nameInput} onChange={onChangeName} />
        </KeyValue>
        <ChartTypeSelect chart={chart} />
      </Property>

      <PropertyLabel>Selected&nbsp;Accounts</PropertyLabel>
      <Property>
        <Row className="button">
          <button onClick={onClickAccounts}>{selectedAccountsCount}&nbsp;selected</button>
        </Row>
      </Property>

      {children}

      <PropertyLabel>&nbsp;</PropertyLabel>
      <Property>
        <Row className="button">
          <DeleteButton confirmMessage="Do you want to delete this chart?" onClick={onClickRemove}>
            Delete
          </DeleteButton>
        </Row>
      </Property>
    </Properties>
  );
};
