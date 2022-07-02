import { Dispatch } from "react";
import { SortingKey, SortingOptions, VisibilityOptions } from ".";

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

  const flipSortingByKey = (key: SortingKey) => {
    const existingValue = sortingOptions.get(key);
    const newValue = existingValue === "ascending" ? "descending" : "ascending";
    sortingOptions.delete(key);
    sortingOptions.set(key, newValue);
    return setSortingOptions(new Map(sortingOptions));
  };

  const getSortingArrowSymbolByKey = (key: SortingKey) => {
    switch (sortingOptions.get(key)) {
      case "ascending":
        return "↑";
      case "descending":
        return "↓";
      default:
        return "";
    }
  };

  return (
    <thead>
      <tr>
        <td>
          <div>
            <button onClick={() => flipSortingByKey("authorized_date")}>
              Date {getSortingArrowSymbolByKey("authorized_date")}
            </button>
          </div>
        </td>
        <td>
          <div>
            <button onClick={() => flipSortingByKey("merchant_name")}>
              Name {getSortingArrowSymbolByKey("merchant_name")}
            </button>
          </div>
        </td>
        <td>
          <div>
            <button onClick={() => flipSortingByKey("amount")}>
              Amount {getSortingArrowSymbolByKey("amount")}
            </button>
          </div>
        </td>
        <td>
          <div>
            <button onClick={() => flipSortingByKey("account")}>
              Account {getSortingArrowSymbolByKey("account")}
            </button>
          </div>
        </td>
        <td>
          <div>
            <button onClick={() => flipSortingByKey("institution")}>
              Institution {getSortingArrowSymbolByKey("institution")}
            </button>
          </div>
        </td>
        <td>
          <div>
            <button onClick={() => flipSortingByKey("category")}>
              Category {getSortingArrowSymbolByKey("category")}
            </button>
          </div>
        </td>
      </tr>
    </thead>
  );
};

export default TransactionsHead;
