import { MouseEventHandler, useState } from "react";
import "./index.css";

interface Props {
  onComplete: MouseEventHandler<HTMLButtonElement>;
  onCancel: MouseEventHandler<HTMLButtonElement>;
  onDelete: MouseEventHandler<HTMLButtonElement>;
}

const ActionButtons = ({ onComplete, onCancel, onDelete }: Props) => {
  const [isDeleteButtonLocked, setIsDeleteButtonLocked] = useState(true);

  const classes = ["ActionButtons"];
  if (isDeleteButtonLocked) classes.push("locked");

  return (
    <div className={classes.join(" ")}>
      <button
        className="complete"
        onClick={(e) => {
          e.stopPropagation();
          onComplete(e);
        }}
      >
        <span className="colored">✓</span>
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
        <span className="colored">✕</span>
        <span>&nbsp;Cancel</span>
      </button>
      <button
        className="delete colored"
        onMouseLeave={() => setIsDeleteButtonLocked(true)}
        onClick={(e) => {
          e.stopPropagation();
          if (!isDeleteButtonLocked) onDelete(e);
          setIsDeleteButtonLocked((s) => !s);
        }}
      >
        <span>⌫</span>
        {!isDeleteButtonLocked && <span>&nbsp;Delete</span>}
      </button>
    </div>
  );
};

export default ActionButtons;
