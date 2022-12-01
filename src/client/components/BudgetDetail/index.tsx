import { useMemo } from "react";
import { Budget, NewSectionGetResponse } from "server";
import { useAppContext, call, PATH } from "client";
import { BudgetBar } from "client/components";
import SectionBar from "./SectionBar";
import "./index.css";

interface Props {
  budget: Budget & { amount?: number };
}

const BudgetDetail = ({ budget }: Props) => {
  const { budget_id } = budget;
  const { sections, setSections, router } = useAppContext();

  const sectionComponents = useMemo(() => {
    const components: JSX.Element[] = [];
    sections.forEach((e) => {
      if (e.budget_id !== budget_id) return;
      const component = <SectionBar key={e.section_id} section={e} />;
      components.push(component);
    });
    return components;
  }, [sections, budget_id]);

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
    const params = new URLSearchParams({ option: "unsorted", budget_id });
    router.go(PATH.TRANSACTIONS, { params });
  };

  return (
    <div className="BudgetDetail">
      <BudgetBar budget={budget} />
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
  );
};

export default BudgetDetail;
