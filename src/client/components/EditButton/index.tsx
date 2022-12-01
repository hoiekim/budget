import { MouseEventHandler } from "react";
import "./index.css";

interface Props {
  isEditting: boolean;
  onEdit: MouseEventHandler<HTMLButtonElement>;
  onDelete: MouseEventHandler<HTMLButtonElement>;
}

const EditButton = ({ isEditting, onEdit, onDelete }: Props) => {
  if (isEditting)
    return (
      <button
        className="EditButton delete colored"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(e);
        }}
      >
        ✕
      </button>
    );
  return (
    <button
      className="EditButton edit"
      onClick={(e) => {
        e.stopPropagation();
        onEdit(e);
      }}
    >
      ✎
    </button>
  );
};

export default EditButton;
