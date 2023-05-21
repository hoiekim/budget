import { useEffect, useMemo } from "react";
import { NewSectionGetResponse } from "server";
import {
  TransactionsPageParams,
  useAppContext,
  call,
  PATH,
  useLocalStorage,
  DateLabel,
  MoneyLabel,
} from "client";
import { Section, ViewDate, getIndex } from "common";
import {
  BudgetBar,
  Graph,
  SectionBar,
  GraphInput,
  AreaInput,
  LineInput,
} from "client/components";
import "./index.css";

export type BudgetDetailPageParams = {
  budget_id?: string;
};

const BudgetDetailPage = () => {
  const { transactions, accounts, budgets, router, sections, setSections, viewDate } =
    useAppContext();
  const { path, params, transition } = router;
  let budget_id: string;
  if (path === PATH.BUDGET_DETAIL) budget_id = params.get("budget_id") || "";
  else budget_id = transition.incomingParams.get("budget_id") || "";
  const budget = budgets.get(budget_id);

  const [sectionsOrder, setSectionsOrder] = useLocalStorage<string[]>(
    `sectionsOrder_${budget_id}`,
    []
  );

  useEffect(() => {
    setSectionsOrder((oldOrder) => {
      const set = new Set(oldOrder);
      sections.forEach((section, key) => {
        if (section.budget_id === budget_id) set.add(key);
      });
      return Array.from(set.values());
    });
  }, [sections, budget_id, setSectionsOrder]);

  const sectionBars = Array.from(sections)
    .filter(([_section_id, section]) => section.budget_id === budget_id)
    .sort(([a], [b]) => {
      const indexA = getIndex(a, sectionsOrder);
      const indexB = getIndex(b, sectionsOrder);
      if (indexA === undefined || indexB === undefined) return 0;
      return indexA - indexB;
    })
    .map(([section_id, section]) => {
      return (
        <SectionBar key={section_id} section={section} onSetOrder={setSectionsOrder} />
      );
    });

  const onClickAddSection = async () => {
    const queryString = "?" + new URLSearchParams({ parent: budget_id }).toString();
    const { data } = await call.get<NewSectionGetResponse>(
      "/api/new-section" + queryString
    );

    if (!data) return;

    const { section_id } = data;

    setSections((oldSections) => {
      const newSections = new Map(oldSections);
      if (section_id) {
        const newSection = new Section({ section_id, budget_id });
        newSections.set(section_id, newSection);
      }
      return newSections;
    });

    router.go(PATH.BUDGET_CONFIG, { params: new URLSearchParams({ id: section_id }) });
  };

  const onClickUnsorted = () => {
    const paramObj: TransactionsPageParams = { option: "unsorted", budget_id };
    const params = new URLSearchParams(paramObj);
    router.go(PATH.TRANSACTIONS, { params });
  };

  const graphData: GraphInput = useMemo(() => {
    if (!budget) return {};

    const interval = viewDate.getInterval();
    const dateHelper = new ViewDate(interval);

    const currentCapacity = budget.getActiveCapacity(dateHelper.getDate());
    const isIncome = currentCapacity[interval] < 0;
    const sign = isIncome ? -1 : 1;

    const spendingHistory: number[] = [];

    transactions.forEach((transaction) => {
      const { authorized_date, date, amount, account_id } = transaction;
      const account = accounts.get(account_id);
      if (!account) return;
      const _budget_id = transaction.label.budget_id || account.label.budget_id;
      if (budget_id !== _budget_id) return;
      const transactionDate = new Date(authorized_date || date);
      const span = dateHelper.getSpanFrom(transactionDate);
      if (!spendingHistory[span]) spendingHistory[span] = 0;
      spendingHistory[span] += sign * amount;
    });

    const { length } = spendingHistory;
    if (length < 2) return {};

    const lengthFixer = 3 - ((length - 1) % 3);

    for (let i = 0; i < length; i++) {
      const e = spendingHistory[i];
      if (!e || e < 0) spendingHistory[i] = 0;
    }

    spendingHistory.push(...new Array(lengthFixer));
    spendingHistory.reverse();

    const clonedViewDate = dateHelper.clone();
    const capacityHistory = new Array(length).fill(undefined).map(() => {
      const capacity = budget.getActiveCapacity(clonedViewDate.getDate());
      clonedViewDate.previous();
      return sign * capacity[interval];
    });

    capacityHistory.push(...new Array(lengthFixer).fill(capacityHistory[length - 1]));
    capacityHistory.reverse();

    const lines: LineInput[] = [
      { sequence: capacityHistory, color: "#aaa", type: "perpendicular" },
      { sequence: spendingHistory, color: "#097", type: "perpendicular" },
    ];

    const { roll_over, roll_over_start_date } = budget;

    if (!roll_over || !roll_over_start_date) return { lines };

    const upperBound = [];
    const lowerBound = [];
    const rollOverStartSpan = length - 1 - dateHelper.getSpanFrom(roll_over_start_date);

    for (let i = rollOverStartSpan + lengthFixer; i < length + lengthFixer; i++) {
      upperBound[i] = capacityHistory[i];
      lowerBound[i] = spendingHistory[i];
    }

    const area: AreaInput = {
      upperBound,
      lowerBound,
      color: "#a82",
      type: "perpendicular",
    };

    return { lines, area };
  }, [transactions, viewDate, accounts, budget, budget_id]);

  return (
    <div className="BudgetDetailPage">
      {budget && (
        <div className="BudgetDetail">
          <BudgetBar budget={budget} />
          <div className="unsortedButton sidePadding">
            <button onClick={onClickUnsorted}>See Unsorted Transactions &gt;&gt;</button>
          </div>

          {!!(graphData.lines || graphData.area) && (
            <div className="sidePadding">
              <Graph
                data={graphData}
                labelX={new DateLabel(viewDate)}
                labelY={new MoneyLabel(budget.iso_currency_code)}
                memoryKey={budget_id}
              />
            </div>
          )}
          <div className="children">
            <div>
              {sectionBars}
              <div className="addButton">
                <button onClick={onClickAddSection}>+</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default BudgetDetailPage;
