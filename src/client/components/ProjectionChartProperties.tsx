import { ChartType, getDateString, LocalDate, Optional, ViewDate } from "common";
import {
  Chart,
  ProjectionChart,
  CapacityInput,
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
  ToggleInput,
  BalanceData,
  ProjectionChartConfiguration,
  AmountInTime,
  CapacityNumberInput,
  inferSavingConfig,
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
  const { chart_id, name, type, configuration } = chart;

  const { data, calculations } = useAppContext();
  const { accounts } = data;

  const [selectedType, setSelectedType] = useState<ChartType>(type);
  const [nameInput, setNameInput] = useState(name);
  const [configInput, setConfigInput] = useState(new ProjectionChartConfiguration(configuration));

  const setPartialConfigInput = (config: Partial<ProjectionChartConfiguration>) => {
    setConfigInput((old) => new ProjectionChartConfiguration({ ...old, ...config }));
  };

  const {
    account_ids,
    initial_saving,
    contribution,
    living_cost,
    anual_percentage_yield,
    year_over_year_inflation,
  } = configInput;

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

  const onClickAccounts: MouseEventHandler<HTMLButtonElement> = (_e) => {
    router.go(PATH.CHART_ACCOUNTS, { params: new URLSearchParams({ chart_id }) });
  };

  const inferredSavingConfig = inferSavingConfig(
    calculations.balanceData,
    account_ids,
    new ViewDate("month"),
  );

  const onChangeAutoConfig: ChangeEventHandler<HTMLInputElement> = (e) => {
    e.stopPropagation();
    const { checked } = e.target;
    const newConfig = { ...configuration, auto_saving_config: checked };
    setPartialConfigInput(newConfig);
    updateChart({ configuration: newConfig });
  };

  const onBlurConfigInput = () => updateChart({ configuration: configInput });

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

      <PropertyLabel>Selected&nbsp;Accounts</PropertyLabel>
      <Property>
        <Row className="button">
          <button onClick={onClickAccounts}>{numberOfSelectedAccounts}&nbsp;selected</button>
        </Row>
      </Property>

      {children}

      <PropertyLabel>
        Saving&nbsp;Configuration
        <KeyValue name="Auto">
          <ToggleInput
            compact={true}
            checked={configInput.auto_saving_config}
            onChange={onChangeAutoConfig}
          />
        </KeyValue>
      </PropertyLabel>
      <Property>
        <KeyValue name="Initial&nbsp;Saving">
          <div>
            <CapacityNumberInput
              style={{ width: 100 }}
              disabled={configInput.auto_saving_config}
              value={
                configInput.auto_saving_config
                  ? inferredSavingConfig.initial_saving.amount
                  : initial_saving.amount
              }
              setValue={(v) =>
                setPartialConfigInput({ initial_saving: { ...initial_saving, amount: v } })
              }
              onBlur={onBlurConfigInput}
            />
            <span className="small">&nbsp;$</span>
          </div>
        </KeyValue>
        <KeyValue name="Initial&nbsp;Saving&nbsp;as&nbsp;of">
          <input
            type="date"
            disabled={configInput.auto_saving_config}
            value={
              configInput.auto_saving_config
                ? getDateString(inferredSavingConfig.initial_saving.amountAsOf)
                : getDateString(initial_saving.amountAsOf)
            }
            onChange={(e) =>
              setPartialConfigInput({
                initial_saving: { ...initial_saving, amountAsOf: new LocalDate(e.target.value) },
              })
            }
            onBlur={onBlurConfigInput}
            aria-label="Initial saving as of date"
          />
        </KeyValue>
        <KeyValue name="Monthly&nbsp;Contribution">
          <div>
            <CapacityNumberInput
              style={{ width: 100 }}
              disabled={configInput.auto_saving_config}
              value={
                configInput.auto_saving_config ? inferredSavingConfig.contribution : contribution
              }
              setValue={(v) => setPartialConfigInput({ contribution: v })}
              onBlur={onBlurConfigInput}
            />
            <span className="small">&nbsp;$</span>
          </div>
        </KeyValue>
        <KeyValue name="Anual&nbsp;Percentage&nbsp;Yield">
          <div>
            <CapacityNumberInput
              style={{ width: 100 }}
              disabled={configInput.auto_saving_config}
              value={
                ((configInput.auto_saving_config
                  ? inferredSavingConfig.anual_percentage_yield
                  : anual_percentage_yield) -
                  1) *
                100
              }
              setValue={(v) => setPartialConfigInput({ anual_percentage_yield: v / 100 + 1 })}
              maxValue={1000}
              minValue={0}
              fixed={2}
              onBlur={onBlurConfigInput}
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
