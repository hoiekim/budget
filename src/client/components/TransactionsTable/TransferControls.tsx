import { useRef, useState } from "react";
import { CheckIcon, TransferPairModal } from "client/components";

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
 * where confirm and reject are named, symmetric buttons. The checkmark
 * confirms immediately, like the quick-accept on suggested category
 * labels.
 *
 * Renders as direct children of `.budgetCategoryActions` so the chip takes
 * the same box as `.labelControls` and the checkmark sits in the same
 * fixed-width `.confirmButtonBox` slot — the chip's width never depends on
 * whether a checkmark is beside it.
 */
const TransferControls = ({ onConfirm, onReject }: Props) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  // The in-flight guard lives here, not in the dialog: every dismissal path
  // unmounts the dialog, and a guard that dies with it lets the reopened
  // dialog issue a second, conflicting write for the same pair. The ref is
  // what refuses a click, because `setBusy` lands on the next render and the
  // dialog's buttons stay clickable to keep the pressed one focusable; `busy`
  // only drives the rendered state.
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);

  // Only a landed write closes the dialog. The actions resolve on refusal
  // too, so closing on completion would read as success on a failed reject.
  const run = (action: () => Promise<boolean>) => async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      if (await action()) setIsModalOpen(false);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <>
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
      <div className="confirmButtonBox">
        <button
          className="confirmButton"
          aria-label="Confirm transfer"
          onClick={run(onConfirm)}
        >
          <CheckIcon size={20} />
        </button>
      </div>
    </>
  );
};

export default TransferControls;
