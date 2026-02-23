import { ButtonHTMLAttributes, MouseEventHandler } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "client/components";
import "./index.css";

type Props = {
  isCompact: boolean;
  onEdit: MouseEventHandler<HTMLButtonElement>;
} & ButtonHTMLAttributes<HTMLButtonElement>;

const EditButton = ({ isCompact, onEdit, className, type: _type, ...rest }: Props) => {
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
        {isCompact ? (
          <div className="reorderIcon">
            <ChevronUpIcon size={8} />
            <ChevronDownIcon size={8} />
          </div>
        ) : (
          <span className="rotate90deg" style={{ letterSpacing: "-1px" }}>
            ✎
          </span>
        )}
      </button>
    </div>
  );
};

export default EditButton;
