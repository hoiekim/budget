import { useEffect, useState } from "react";
import { NewSectionGetResponse } from "server";
import {
  TransactionsPageParams,
  useAppContext,
  call,
  PATH,
  useLocalStorage,
  getIndex,
} from "client";
import { BudgetBar, SectionBar } from "client/components";
import "./index.css";

export type BudgetDetailPageParams = {
  budget_id?: string;
};

const BudgetDetailPage = () => {
  const { budgets, router, sections, setSections } = useAppContext();
  const { path, params, transition } = router;
  let budget_id: string;
  if (path === PATH.BUDGET_DETAIL) budget_id = params.get("budget_id") || "";
  else budget_id = transition.incomingParams.get("budget_id") || "";
  const budget = budgets.get(budget_id);
  const editingState = useState<string | null>(null);

  const [editingDataId, setEditingDataId] = editingState;
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
        <SectionBar
          key={section_id}
          section={section}
          editingState={editingState}
          onSetOrder={setSectionsOrder}
        />
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
        newSections.set(section_id, {
          section_id,
          budget_id,
          name: "",
          capacities: [{ year: 0, month: 0, week: 0, day: 0 }],
          roll_over: false,
        });
      }
      return newSections;
    });

    setEditingDataId(section_id);
  };

  const onClickUnsorted = () => {
    const paramObj: TransactionsPageParams = { option: "unsorted", budget_id };
    const params = new URLSearchParams(paramObj);
    router.go(PATH.TRANSACTIONS, { params });
  };

  return (
    <div className="BudgetDetailPage">
      {budget && (
        <div className="BudgetDetail">
          <BudgetBar budget={budget} editingState={editingState} />
          <div className="unsortedButton">
            <button onClick={onClickUnsorted} disabled={editingDataId === budget_id}>
              See Unsorted Transactions &gt;&gt;
            </button>
          </div>
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
