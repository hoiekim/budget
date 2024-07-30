import { DetailedHTMLProps, HTMLAttributes } from "react";
import { useAppContext } from "client";
import { BudgetLike } from "common/models/BudgetLike";
import "./index.css";

type Props = {
  budgetLike: BudgetLike;
} & DetailedHTMLProps<HTMLAttributes<HTMLDivElement>, HTMLDivElement>;

const Donut = ({ budgetLike, className = "", ...rest }: Props) => {
  const {} = useAppContext();

  const classes = [className];

  return <div {...rest} className={classes.join(" ")}></div>;
};

export default Donut;
