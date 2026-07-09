import { ReactNode } from "react";
import "./index.css";

interface Props {
  children: ReactNode;
  className?: string;
}

export const Placeholder = ({ children, className }: Props) => {
  const classes = ["Placeholder", className].filter(Boolean).join(" ");
  return <div className={classes}>{children}</div>;
};
