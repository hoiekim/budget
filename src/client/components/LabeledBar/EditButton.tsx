import { MouseEventHandler } from "react";
import "./index.css";

interface Props {
  onEdit: MouseEventHandler<HTMLButtonElement>;
}

const EditButton = ({ onEdit }: Props) => {
  return (
    <div className="EditButton">
      <button
        className="edit"
        onClick={(e) => {
          e.stopPropagation();
          onEdit(e);
        }}
      >
        ✎
      </button>
    </div>
  );
};

export default EditButton;
