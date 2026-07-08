import { ReactNode } from "react";
import "./index.css";

interface Props {
  /** Reflects the option's current selected state via the checkbox tick. */
  checked: boolean;
  /** Called on button click. Consumers typically wire to a `toggle(value)`
   * or `clearAll()` from `useMultiSelectQueryFilter`. */
  onSelect: () => void;
  children: ReactNode;
}

/**
 * A single row inside a `<PageFilterTitle>` dropdown. Renders a checkbox
 * ✓ mark + label wrapped in a full-width button. Layout / hover
 * chrome comes from the `h2.PageFilterTitle > div.select > div.options
 * > button` rules on the parent shell — this component just supplies
 * the checkbox + label content.
 */
export const FilterOption = ({ checked, onSelect, children }: Props) => (
  <button onClick={onSelect}>
    <span className={"checkbox" + (checked ? " checked" : "")} aria-hidden="true" />
    <span>{children}</span>
  </button>
);
