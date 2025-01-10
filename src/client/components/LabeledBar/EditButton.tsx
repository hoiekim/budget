import { ButtonHTMLAttributes, MouseEventHandler } from "react";
import "./index.css";

type Props = {
  isCompact: boolean;
  onEdit: MouseEventHandler<HTMLButtonElement>;
} & ButtonHTMLAttributes<HTMLButtonElement>;

const EditButton = ({ isCompact, onEdit, className, type, ...rest }: Props) => {
  let _className = ["EditButton", className].filter(Boolean).join(" ");
  if (isCompact) _className += " small";
  else _className += " big";
  return (
    <div className={_className}>
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!isCompact) onEdit(e);
        }}
        {...rest}
      >
        <span className="rotate90deg" style={{ letterSpacing: "-1px" }}>
          {isCompact ? <>〈&nbsp;〉</> : "✎"}
        </span>
      </button>
    </div>
  );
};

export default EditButton;
