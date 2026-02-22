import { MouseEventHandler, useState } from "react";
import "./index.css";

interface Props {
  onComplete: MouseEventHandler<HTMLButtonElement>;
  onCancel: MouseEventHandler<HTMLButtonElement>;
  onDelete?: MouseEventHandler<HTMLButtonElement>;
}

export const ActionButtons = ({ onComplete, onCancel, onDelete }: Props) => {
  const [isDeleteButtonLocked, setIsDeleteButtonLocked] = useState(true);

  const classes = ["ActionButtons"];
  if (onDelete) classes.push("lockable");
  if (isDeleteButtonLocked) classes.push("locked");

  return (
    <div className={classes.join(" ")}>
      <button
        className="complete colored"
        onClick={(e) => {
          e.stopPropagation();
          onComplete(e);
        }}
      >
        <span>&nbsp;Save</span>
      </button>
      <button
        className="cancel"
        onClick={(e) => {
          e.stopPropagation();
          setIsDeleteButtonLocked(true);
          onCancel(e);
        }}
      >
        <span>&nbsp;Cancel</span>
      </button>
      {!!onDelete && (
        <button
          className="delete colored"
          onMouseLeave={() => setIsDeleteButtonLocked(true)}
          onClick={(e) => {
            e.stopPropagation();
            if (!isDeleteButtonLocked) onDelete(e);
            if (isDeleteButtonLocked) setTimeout(() => setIsDeleteButtonLocked(true), 5000);
            setIsDeleteButtonLocked((s) => !s);
          }}
        >
          <span>{isDeleteButtonLocked ? "⌫" : "Delete"}</span>
        </button>
      )}
    </div>
  );
};
