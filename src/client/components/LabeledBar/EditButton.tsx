import { ButtonHTMLAttributes, MouseEventHandler } from "react";
import "./index.css";

type Props = {
  onEdit: MouseEventHandler<HTMLButtonElement>;
} & ButtonHTMLAttributes<HTMLButtonElement>;

const EditButton = ({ onEdit, className, ...rest }: Props) => {
  const _className = ["EditButton", className].filter(Boolean).join(" ");
  return (
    <div className={_className}>
      <button
        className="rotate90deg"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onEdit(e);
        }}
        {...rest}
      >
        <span>&#9881;</span>
      </button>
    </div>
  );
};

export default EditButton;
