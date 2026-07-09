import { MouseEventHandler, ReactNode } from "react";

interface Props {
  /**
   * If set, `window.confirm(message)` gates the click — the wrapped
   * `onClick` only fires when the user confirms. Every site in this
   * codebase that renders a destructive button paired the button JSX
   * with a bespoke `if (!window.confirm(...)) return;` line, so
   * folding the gate into the component keeps the messaging
   * consistent + removes ~8 duplicated call sites.
   */
  confirmMessage?: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
  /** Button label. Defaults to `"Delete"`. */
  children?: ReactNode;
  /** Extra class string appended after the base `delete colored`. */
  className?: string;
}

/**
 * Destructive button styled with the codebase's `delete colored` class
 * pair. Meant for use inside `<Properties>` / `<Row>` context — the
 * `div.Properties .row button.delete` CSS rule paints the text
 * `var(--darkRed)`. For the solid-fill variant sitting inside
 * `<ActionButtons>`, see that component instead (self-contained widget,
 * not extracted here).
 */
export const DeleteButton = ({ confirmMessage, onClick, children = "Delete", className }: Props) => {
  const classes = ["delete", "colored", className].filter(Boolean).join(" ");
  const handleClick: MouseEventHandler<HTMLButtonElement> = (e) => {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    onClick(e);
  };
  return (
    <button type="button" className={classes} onClick={handleClick}>
      {children}
    </button>
  );
};
