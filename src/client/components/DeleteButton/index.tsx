import { MouseEventHandler, ReactNode } from "react";

const DEFAULT_CONFIRM_MESSAGE = "Are you sure you want to delete this?";

interface Props {
  /** Prompt shown by `window.confirm` before `onClick` fires. Defaults to a
   * generic message; every consumer should pass a specific one. */
  confirmMessage?: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
  /** Button label. Defaults to `"Delete"`. */
  children?: ReactNode;
  /** Extra class string appended after the base `delete colored`. */
  className?: string;
}

export const DeleteButton = ({
  confirmMessage = DEFAULT_CONFIRM_MESSAGE,
  onClick,
  children = "Delete",
  className,
}: Props) => {
  const classes = ["delete", "colored", className].filter(Boolean).join(" ");
  const handleClick: MouseEventHandler<HTMLButtonElement> = (e) => {
    if (!window.confirm(confirmMessage)) return;
    onClick(e);
  };
  return (
    <button type="button" className={classes} onClick={handleClick}>
      {children}
    </button>
  );
};
