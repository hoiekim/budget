import { Category } from "server";

interface Props {
  category: Category;
}

const CategoryComponent = ({ category }: Props) => {
  // TODO: get total expenses
  const currentTotal = 0;
  return (
    <div className="CategoryComponent">
      <div>
        {category.name} {currentTotal}/{category.capacity}
      </div>
    </div>
  );
};

export default CategoryComponent;
