import { getDateString, LocalDate } from "common";
import {
  Chart,
  ProjectionChart,
  CapacityInput,
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
import {
  ChangeEventHandler,
  FocusEventHandler,
  MouseEventHandler,
  ReactNode,
  useState,
} from "react";

interface ProjectionChartPropertiesProps {
  chart: ProjectionChart;
  children?: ReactNode;
}

export const ProjectionChartProperties = ({ chart, children }: ProjectionChartPropertiesProps) => {
  const { router } = useAppContext();
  const { chart_id, name, configuration } = chart;

  const {
    account_ids,
    initial_saving,
    contribution,
    living_cost,
    anual_percentage_yield,
    year_over_year_inflation,
  } = configuration;

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

  const onClickAccounts: MouseEventHandler<HTMLButtonElement> = (_e) => {
    router.go(PATH.CHART_ACCOUNTS, { params: new URLSearchParams({ chart_id }) });
  };

  const onBlurInitialSavingAmount: FocusEventHandler<HTMLInputElement> = (e) => {
    const newAmount = +e.target.value;
    const newConfiguration = {
      ...configuration,
      initial_saving: { ...initial_saving, amount: newAmount },
    };
    updateChart({ configuration: newConfiguration });
  };

  const onBlurInitialSavingDate: FocusEventHandler<HTMLInputElement> = (e) => {
    const newDate = new LocalDate(e.target.value);
    const newConfiguration = {
      ...configuration,
      initial_saving: { ...initial_saving, amountAsOf: newDate },
    };
    updateChart({ configuration: newConfiguration });
  };

  const onBlurContribution: FocusEventHandler<HTMLInputElement> = (e) => {
    const newAmount = +e.target.value;
    const newConfiguration = { ...configuration, contribution: newAmount };
    updateChart({ configuration: newConfiguration });
  };

  const onBlurApy: FocusEventHandler<HTMLInputElement> = (e) => {
    const newRate = +e.target.value / 100 + 1;
    const newConfiguration = {
      ...configuration,
      anual_percentage_yield: newRate,
    };
    updateChart({ configuration: newConfiguration });
  };

  const onBlurLivingCostAmount: FocusEventHandler<HTMLInputElement> = (e) => {
    const newAmount = +e.target.value;
    const newConfiguration = {
      ...configuration,
      living_cost: { ...living_cost, amount: newAmount },
    };
    updateChart({ configuration: newConfiguration });
  };

  const onBlurLivingCostDate: FocusEventHandler<HTMLInputElement> = (e) => {
    const newDate = new LocalDate(e.target.value);
    const newConfiguration = {
      ...configuration,
      living_cost: { ...living_cost, amountAsOf: newDate },
    };
    updateChart({ configuration: newConfiguration });
  };

  const onBlurTaxRate: FocusEventHandler<HTMLInputElement> = (e) => {
    const newRate = +e.target.value / 100;
    const newConfiguration = {
      ...configuration,
      living_cost: { ...living_cost, taxRate: newRate },
    };
    updateChart({ configuration: newConfiguration });
  };

  const onBlurYoyInflation: FocusEventHandler<HTMLInputElement> = (e) => {
    const newRate = +e.target.value / 100 + 1;
    const newConfiguration = {
      ...configuration,
      year_over_year_inflation: newRate,
    };
    updateChart({ configuration: newConfiguration });
  };

  const numberOfSelectedAccounts = accounts.filter((a) => {
    return !a.hide && account_ids.includes(a.account_id);
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
        <ChartTypeSelect chart={chart} />
      </Property>

      <PropertyLabel>Selected&nbsp;Accounts</PropertyLabel>
      <Property>
        <Row className="button">
          <button onClick={onClickAccounts}>{numberOfSelectedAccounts}&nbsp;selected</button>
        </Row>
      </Property>

      {children}

      <PropertyLabel>Saving&nbsp;Configuration</PropertyLabel>
      <Property>
        <KeyValue name="Initial&nbsp;Saving">
          <div>
            <CapacityInput
              style={{ width: 100 }}
              defaultValue={initial_saving.amount}
              onBlur={onBlurInitialSavingAmount}
            />
            <span className="small">&nbsp;$</span>
          </div>
        </KeyValue>
        <KeyValue name="Initial&nbsp;Saving&nbsp;as&nbsp;of">
          <input
            type="date"
            defaultValue={getDateString(initial_saving.amountAsOf)}
            onBlur={onBlurInitialSavingDate}
            aria-label="Initial saving as of date"
          />
        </KeyValue>
        <KeyValue name="Monthly&nbsp;Contribution">
          <div>
            <CapacityInput
              style={{ width: 100 }}
              defaultValue={contribution}
              onBlur={onBlurContribution}
            />
            <span className="small">&nbsp;$</span>
          </div>
        </KeyValue>
        <KeyValue name="Anual&nbsp;Percentage&nbsp;Yield">
          <div>
            <CapacityInput
              style={{ width: 100 }}
              defaultValue={(anual_percentage_yield - 1) * 100}
              maxValue={1000}
              minValue={0}
              fixed={2}
              onBlur={onBlurApy}
            />
            <span className="small">&nbsp;%</span>
          </div>
        </KeyValue>
      </Property>
      <PropertyLabel>Goal&nbsp;Configuration</PropertyLabel>
      <Property>
        <KeyValue name="Living&nbsp;Cost">
          <div>
            <CapacityInput
              style={{ width: 100 }}
              defaultValue={living_cost.amount}
              onBlur={onBlurLivingCostAmount}
            />
            <span className="small">&nbsp;$</span>
          </div>
        </KeyValue>
        <KeyValue name="Living&nbsp;Cost&nbsp;as&nbsp;of">
          <input
            type="date"
            defaultValue={getDateString(living_cost.amountAsOf)}
            onBlur={onBlurLivingCostDate}
            aria-label="Living cost as of date"
          />
        </KeyValue>
        <KeyValue name="Tax&nbsp;Rate">
          <div>
            <CapacityInput
              style={{ width: 100 }}
              defaultValue={(living_cost.taxRate || 0) * 100}
              maxValue={100}
              minValue={0}
              fixed={2}
              onBlur={onBlurTaxRate}
            />
            <span className="small">&nbsp;%</span>
          </div>
        </KeyValue>
        <KeyValue name="YoY&nbsp;Inflation">
          <div>
            <CapacityInput
              style={{ width: 100 }}
              defaultValue={(year_over_year_inflation - 1) * 100}
              maxValue={1000}
              minValue={0}
              fixed={2}
              onBlur={onBlurYoyInflation}
            />
            <span className="small">&nbsp;%</span>
          </div>
        </KeyValue>
      </Property>

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
