import { ChangeEventHandler, MouseEventHandler, ReactNode, useState } from "react";
import { ChartType } from "common";
import {
  BalanceChart,
  Chart,
  PATH,
  useAppContext,
  useDebounce,
  useMutate,
  getChartTypeName,
  DeleteButton,
  Properties,
  PropertyLabel,
  Property,
  Row,
  KeyValue,
} from "client";

interface BalanceChartPropertiesProps {
  chart: BalanceChart;
  children?: ReactNode;
}

export const BalanceChartProperties = ({ chart, children }: BalanceChartPropertiesProps) => {
  const { router } = useAppContext();
  const { name, chart_id, type, configuration } = chart;
  const { account_ids, budget_ids } = configuration;

  const { data } = useAppContext();
  const { accounts, budgets } = data;

  const [nameInput, setNameInput] = useState(name);
  const [selectedType, setSelectedType] = useState<ChartType>(type);

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

  const onChangeType: ChangeEventHandler<HTMLSelectElement> = (e) => {
    const newType = e.target.value as ChartType;
    setSelectedType(newType);
    updateChart({ type: newType });
  };

  const onClickAccounts: MouseEventHandler<HTMLButtonElement> = () => {
    router.go(PATH.CHART_ACCOUNTS, { params: new URLSearchParams({ chart_id }) });
  };

  const selectedAccountsCount = accounts.filter((a) => {
    return !a.hide && account_ids.includes(a.id);
  }).length;

  const selectedBudgetsCount = budgets.filter((b) => {
    return budget_ids.includes(b.id);
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
          <input value={nameInput} onChange={onChangeName} aria-label="Chart name" />
        </KeyValue>
        <KeyValue name="Chart&nbsp;Type">
          <select value={selectedType} onChange={onChangeType}>
            {Object.values(ChartType).map((v) => {
              const chartTypeName = getChartTypeName(v);
              return (
                <option key={`chart_type_option_${v}`} value={v}>
                  {chartTypeName}
                </option>
              );
            })}
          </select>
        </KeyValue>
      </Property>

      <PropertyLabel>Selected&nbsp;Accounts&nbsp;&&nbsp;Budgets</PropertyLabel>
      <Property>
        <Row className="button">
          <button onClick={onClickAccounts}>
            {selectedAccountsCount + selectedBudgetsCount}&nbsp;selected
          </button>
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
