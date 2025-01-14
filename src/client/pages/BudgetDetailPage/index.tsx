import { useEffect } from "react";
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
import { Budget, Data, Section, SectionDictionary } from "common";
import { BudgetBar, Graph, SectionBar } from "client/components";
import "./index.css";
import { useGraph } from "./lib";

export type BudgetDetailPageParams = {
  budget_id?: string;
};

const BudgetDetailPage = () => {
  const { data, setData, router, viewDate } = useAppContext();
  const { budgets, sections } = data;
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
      const indexA = sectionsOrder.indexOf(a);
      const indexB = sectionsOrder.indexOf(b);
      if (indexA === undefined || indexB === undefined) return 0;
      return indexA - indexB;
    })
    .map(([section_id, section]) => {
      return <SectionBar key={section_id} section={section} onSetOrder={setSectionsOrder} />;
    });

  const onClickAddSection = async () => {
    const queryString = "?" + new URLSearchParams({ parent: budget_id }).toString();
    const { body } = await call.get<NewSectionGetResponse>("/api/new-section" + queryString);

    if (!body) return;

    const { section_id } = body;

    setData((oldData) => {
      if (section_id) {
        const newData = new Data(oldData);
        const newSection = new Section({ section_id, budget_id });
        const newSections = new SectionDictionary(newData.sections);
        newSections.set(section_id, newSection);
        newData.sections = newSections;
        return newData;
      }
      return oldData;
    });

    router.go(PATH.BUDGET_CONFIG, { params: new URLSearchParams({ id: section_id }) });
  };

  const onClickUnsorted = () => {
    const paramObj: TransactionsPageParams = { option: "unsorted", budget_id };
    const params = new URLSearchParams(paramObj);
    router.go(PATH.TRANSACTIONS, { params });
  };

  const { graphData, graphViewDate } = useGraph(budget || new Budget());

  const { number_of_unsorted_items } = budget || {};

  const capacity = budget?.getActiveCapacity(viewDate.getEndDate());
  const isInfinite = !!capacity?.isInfinite;

  return (
    <div className="BudgetDetailPage">
      {budget && (
        <div className="BudgetDetail">
          <BudgetBar budget={budget} />
          <div className="unsortedButton sidePadding">
            <button onClick={onClickUnsorted} disabled={!number_of_unsorted_items}>
              {number_of_unsorted_items ? (
                <>See {number_of_unsorted_items} Unsorted Transactions &gt;&gt;</>
              ) : (
                <>There is no unsorted transactions</>
              )}
            </button>
          </div>

          {!!(graphData.lines || graphData.areas) && !isInfinite && (
            <div className="sidePadding">
              <Graph
                data={graphData}
                labelX={new DateLabel(graphViewDate)}
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
