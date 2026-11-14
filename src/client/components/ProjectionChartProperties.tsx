import { getDateString, LocalDate, US_STATE_NAMES, ViewDate } from "common";
import {
  Chart,
  ProjectionChart,
  PATH,
  useAppContext,
  useDebounce,
  useMutate,
  DeleteButton,
  Properties,
  PropertyLabel,
  Property,
  ButtonRow,
  Row,
  KeyValue,
  ChartTypeSelect,
  ToggleInput,
  ProjectionChartConfiguration,
  CapacityNumberInput,
  inferSavingConfig,
  useGoalConfig,
} from "client";
import {
  ChangeEventHandler,
  MouseEventHandler,
  ReactNode,
  useEffect,
  useState,
} from "react";

interface ProjectionChartPropertiesProps {
  chart: ProjectionChart;
  children?: ReactNode;
}

export const ProjectionChartProperties = ({ chart, children }: ProjectionChartPropertiesProps) => {
  const { router } = useAppContext();
  const { chart_id, name, configuration } = chart;

  const { data, calculations } = useAppContext();
  const { accounts, budgets, inflation } = data;

  const [nameInput, setNameInput] = useState(name);
  const [configInput, setConfigInput] = useState(new ProjectionChartConfiguration(configuration));

  useEffect(() => {
    setConfigInput(new ProjectionChartConfiguration(configuration));
  }, [configuration]);

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
    auto_goal_config,
    budget_ids,
  } = configInput;

  const goalConfig = useGoalConfig(configInput);
  const shownLivingCost = auto_goal_config ? goalConfig.living_cost : living_cost;
  const shownInflation = auto_goal_config
    ? goalConfig.year_over_year_inflation
    : year_over_year_inflation;

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

  const inferredSavingConfig = inferSavingConfig(
    calculations.balanceData,
    account_ids,
    new ViewDate("month"),
  );

  const onChangeAutoConfig: ChangeEventHandler<HTMLInputElement> = (e) => {
    e.stopPropagation();
    const { checked } = e.target;
    const newConfig = { ...configInput, auto_saving_config: checked };
    setPartialConfigInput(newConfig);
    updateChart({ configuration: newConfig });
  };

  const onBlurConfigInput = () => updateChart({ configuration: configInput });

  const onBlurApy = (e: { target: { value: number } }) => {
    updateChart({ configuration: { ...configInput, anual_percentage_yield: e.target.value / 100 + 1 } });
  };

  const onChangeAutoGoalConfig: ChangeEventHandler<HTMLInputElement> = (e) => {
    e.stopPropagation();
    const { checked } = e.target;
    const newConfig = { ...configInput, auto_goal_config: checked };
    setPartialConfigInput(newConfig);
    updateChart({ configuration: newConfig });
  };

  // Blur fires before `setValue` lands in `configInput`, so save the event's clamped value.
  const onBlurLivingCostAmount = (e: { target: { value: number } }) => {
    updateChart({
      configuration: { ...configInput, living_cost: { ...living_cost, amount: e.target.value } },
    });
  };

  const onBlurTaxRate = (e: { target: { value: number } }) => {
    updateChart({
      configuration: {
        ...configInput,
        living_cost: { ...living_cost, taxRate: e.target.value / 100 },
      },
    });
  };

  const onBlurYoyInflation = (e: { target: { value: number } }) => {
    updateChart({
      configuration: { ...configInput, year_over_year_inflation: e.target.value / 100 + 1 },
    });
  };

  const numberOfSelectedBudgets = budgets.filter((b) => budget_ids.includes(b.id)).length;

  const stateName = goalConfig.state && US_STATE_NAMES[goalConfig.state];
  const taxResidenceLabel = stateName || "Unknown (federal only)";

  const inflationDataLabel = inflation
    ? `CPI ${inflation.from} – ${inflation.to}`
    : inflation === null
      ? "Not collected yet"
      : "Unavailable";

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
        <ButtonRow onClick={onClickAccounts}>{numberOfSelectedAccounts}&nbsp;selected</ButtonRow>
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
              onBlur={onBlurApy}
            />
            <span className="small">&nbsp;%</span>
          </div>
        </KeyValue>
      </Property>
      <PropertyLabel>
        Goal&nbsp;Configuration
        <KeyValue name="Auto">
          <ToggleInput
            compact={true}
            checked={auto_goal_config}
            onChange={onChangeAutoGoalConfig}
            aria-label="Infer goal configuration automatically"
          />
        </KeyValue>
      </PropertyLabel>
      <Property>
        {auto_goal_config && (
          <ButtonRow onClick={onClickAccounts}>
            {numberOfSelectedBudgets
              ? `Living cost from ${numberOfSelectedBudgets} budget${numberOfSelectedBudgets > 1 ? "s" : ""}`
              : "Select budgets for living cost"}
          </ButtonRow>
        )}
        <KeyValue name="Living&nbsp;Cost">
          <div>
            <CapacityNumberInput
              style={{ width: 100 }}
              disabled={auto_goal_config}
              value={shownLivingCost.amount}
              setValue={(v) => setPartialConfigInput({ living_cost: { ...living_cost, amount: v } })}
              onBlur={onBlurLivingCostAmount}
              aria-label="Living cost"
            />
            <span className="small">&nbsp;$</span>
          </div>
        </KeyValue>
        <KeyValue name="Living&nbsp;Cost&nbsp;as&nbsp;of">
          <input
            type="date"
            disabled={auto_goal_config}
            value={getDateString(shownLivingCost.amountAsOf)}
            onChange={(e) =>
              setPartialConfigInput({
                living_cost: { ...living_cost, amountAsOf: new LocalDate(e.target.value) },
              })
            }
            onBlur={onBlurConfigInput}
            aria-label="Living cost as of date"
          />
        </KeyValue>
        <KeyValue name="Tax&nbsp;Rate">
          <div>
            <CapacityNumberInput
              style={{ width: 100 }}
              disabled={auto_goal_config}
              value={(shownLivingCost.taxRate || 0) * 100}
              setValue={(v) =>
                setPartialConfigInput({ living_cost: { ...living_cost, taxRate: v / 100 } })
              }
              maxValue={100}
              minValue={0}
              fixed={2}
              onBlur={onBlurTaxRate}
              aria-label="Tax rate"
            />
            <span className="small">&nbsp;%</span>
          </div>
        </KeyValue>
        {auto_goal_config && (
          <KeyValue name="Tax&nbsp;Residence">
            <span>{taxResidenceLabel}</span>
          </KeyValue>
        )}
        <KeyValue name="YoY&nbsp;Inflation">
          <div>
            <CapacityNumberInput
              style={{ width: 100 }}
              disabled={auto_goal_config}
              value={(shownInflation - 1) * 100}
              setValue={(v) => setPartialConfigInput({ year_over_year_inflation: v / 100 + 1 })}
              maxValue={1000}
              minValue={0}
              fixed={2}
              onBlur={onBlurYoyInflation}
              aria-label="Year over year inflation"
            />
            <span className="small">&nbsp;%</span>
          </div>
        </KeyValue>
        {auto_goal_config && (
          <KeyValue name="Inflation&nbsp;Data">
            <span>{inflationDataLabel}</span>
          </KeyValue>
        )}
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
