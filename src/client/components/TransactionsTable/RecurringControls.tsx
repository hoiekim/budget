import { useRef, useState } from "react";
import { CheckIcon, RecurringModal } from "client/components";

interface Props {
  merchantName: string;
  onConfirm: () => Promise<boolean>;
  onDismiss: () => Promise<boolean>;
}

/**
 * Suggested-recurring affordance shown in place of the budget/category
 * controls when a transaction row belongs to a recurring with status
 * "suggested" — mirrors `TransferControls` for suggested transfer pairs.
 *
 * The "Recurring" chip opens `RecurringModal`, where confirm and
 * dismiss are named buttons (dismissing writes the denylist, so it must
 * not be one click away). The checkmark confirms immediately, like the
 * quick-accept on suggested category labels.
 */
const RecurringControls = ({ merchantName, onConfirm, onDismiss }: Props) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  // Same in-flight guard shape as TransferControls: the ref refuses the
  // click because `setBusy` lands on the next render and the dialog's
  // buttons stay focusable while busy.
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);

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
    <div className="recurringControls">
      <button className="recurringChip suggested" onClick={() => setIsModalOpen(true)}>
        Recurring
      </button>
      <button
        className="recurringQuickConfirm"
        aria-label="Confirm recurring"
        onClick={run(onConfirm)}
      >
        <CheckIcon size={20} />
      </button>
      {isModalOpen && (
        <RecurringModal
          busy={busy}
          merchantName={merchantName}
          onConfirm={run(onConfirm)}
          onDismiss={run(onDismiss)}
          onClose={() => setIsModalOpen(false)}
        />
      )}
    </div>
  );
};

export default RecurringControls;
