import { CheckIcon } from "client/components";
import { useState } from "react";

interface Props {
  onConfirm: () => Promise<void>;
  onReject: () => Promise<void>;
}

/**
 * Suggested-transfer affordance shown in place of the budget/category controls
 * when a transaction row belongs to a pair with status "suggested" (#354,
 * Phase 3a). Confirm promotes the pair to "confirmed"; Reject soft-deletes it.
 * Both buttons are disabled while their request is in flight so a double-click
 * can't fire the mutation twice.
 */
const TransferControls = ({ onConfirm, onReject }: Props) => {
  const [busy, setBusy] = useState(false);

  const run = (action: () => Promise<void>) => async () => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="transferControls">
      <span className="transferChip suggested clickable" onClick={run(onReject)}>
        Transfer?
      </span>
      <div className="confirmButtonBox">
        <button className="confirmButton" disabled={busy} onClick={run(onConfirm)}>
          <CheckIcon size={20} />
        </button>
      </div>
    </div>
  );
};

export default TransferControls;
