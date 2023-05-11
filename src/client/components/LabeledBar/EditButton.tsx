import { ButtonHTMLAttributes, MouseEventHandler } from "react";
import "./index.css";

type Props = {
  onEdit: MouseEventHandler<HTMLButtonElement>;
} & ButtonHTMLAttributes<HTMLButtonElement>;

const EditButton = ({ onEdit, ...rest }: Props) => {
  return (
    <div className="EditButton">
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onEdit(e);
        }}
        {...rest}
      >
        <span>✎</span>
      </button>
    </div>
  );
};

export default EditButton;
