import { useState } from "react";
import { NewSectionGetResponse } from "server";
import { TransactionsPageParams, useAppContext, call, PATH } from "client";
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

  const sectionComponents: JSX.Element[] = [];
  sections.forEach((e) => {
    if (e.budget_id !== budget_id) return;
    const component = (
      <SectionBar key={e.section_id} section={e} editingState={editingState} />
    );
    sectionComponents.push(component);
  });

  const onClickAddSection = async () => {
    const queryString = "?" + new URLSearchParams({ parent: budget_id }).toString();
    const { data } = await call.get<NewSectionGetResponse>(
      "/api/new-section" + queryString
    );

    setSections((oldSections) => {
      const newSections = new Map(oldSections);
      const section_id = data?.section_id;
      if (section_id) {
        newSections.set(section_id, {
          section_id,
          budget_id,
          name: "",
          capacities: { year: 0, month: 0, week: 0, day: 0 },
        });
      }
      return newSections;
    });
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
            <button onClick={onClickUnsorted}>See Unsorted Transactions &gt;&gt;</button>
          </div>
          <div className="children">
            <div>
              {sectionComponents}
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
