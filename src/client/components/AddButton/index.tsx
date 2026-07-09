import { MouseEventHandler, ReactNode } from "react";
import "./index.css";

interface Props {
  onClick: MouseEventHandler<HTMLButtonElement>;
  children: ReactNode;
  className?: string;
}

export const AddButton = ({ onClick, children, className }: Props) => {
  const classes = ["AddButton", className].filter(Boolean).join(" ");
  return (
    <button className={classes} onClick={onClick}>
      {children}
    </button>
  );
};
