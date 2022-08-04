import { useAppContext } from "client";
import { Section } from "server";
import CategoryComponent from "./CategoryComponent";

interface Props {
  section: Section;
}

const SectionComponent = ({ section }: Props) => {
  const { categories } = useAppContext();
  const categoryComponents = Array.from(categories.values())
    .filter((e) => e.section_id === section.section_id)
    .map((e, i) => {
      return <CategoryComponent key={i} category={e} />;
    });
  // TODO: get total expenses
  const currentTotal = 0;
  return (
    <div className="SectionComponent">
      <div>
        {section.name} {currentTotal}/{section.capacity}
      </div>
      <div>{categoryComponents}</div>
    </div>
  );
};

export default SectionComponent;
