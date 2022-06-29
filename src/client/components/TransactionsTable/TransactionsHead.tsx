import { Dispatch } from "react";
import { SortingOptions, VisibilityOptions } from "./index";

interface Props {
  options: {
    sortingOptions: SortingOptions;
    setSortingOptions: Dispatch<SortingOptions>;
    visibilityOptions: VisibilityOptions;
    setVisibilityOptions: Dispatch<VisibilityOptions>;
  };
}

const TransactionsHead = ({ options }: Props) => {
  const { sortingOptions, setSortingOptions, visibilityOptions, setVisibilityOptions } =
    options;

  return (
    <thead>
      <tr>
        <td>
          <div>Date</div>
        </td>
        <td>
          <div>Name</div>
        </td>
        <td>
          <div>Amount</div>
        </td>
        <td>
          <div>Account</div>
        </td>
        <td>
          <div>Institution</div>
        </td>
        <td>
          <div>Category</div>
        </td>
      </tr>
    </thead>
  );
};

export default TransactionsHead;
