import { useState } from "react";
import { TransferPairModal } from "client/components";

interface Props {
  onConfirm: () => Promise<boolean>;
  onReject: () => Promise<boolean>;
}

/**
 * Suggested-transfer affordance shown in place of the budget/category
 * controls when a transaction row belongs to a pair with status
 * "suggested".
 *
 * The chip carries no outcome of its own — it opens `TransferPairModal`,
 * where confirm and reject are named, symmetric buttons.
 */
const TransferControls = ({ onConfirm, onReject }: Props) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  // The in-flight guard lives here, not in the dialog: every dismissal path
  // unmounts the dialog, and a guard that dies with it lets the reopened
  // dialog issue a second, conflicting write for the same pair.
  const [busy, setBusy] = useState(false);

  // Only a landed write closes the dialog. The actions resolve on refusal
  // too, so closing on completion would read as success on a failed reject.
  const run = (action: () => Promise<boolean>) => async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (await action()) setIsModalOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="transferControls">
      <button className="transferChip suggested" onClick={() => setIsModalOpen(true)}>
        Transfer
      </button>
      {isModalOpen && (
        <TransferPairModal
          busy={busy}
          onConfirm={run(onConfirm)}
          onReject={run(onReject)}
          onClose={() => setIsModalOpen(false)}
        />
      )}
    </div>
  );
};

export default TransferControls;
