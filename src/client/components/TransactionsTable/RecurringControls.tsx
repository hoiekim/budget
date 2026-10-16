interface Props {
  onConfirm: () => Promise<boolean>;
  onDismiss: () => Promise<boolean>;
}

/**
 * Suggested-recurring affordance shown in place of the budget/category
 * controls when a transaction row belongs to a recurring with status
 * "suggested" — mirrors `TransferControls` for suggested transfer pairs.
 *
 * The amber "Recurring" chip names the state; Confirm/Dismiss act on the
 * suggestion directly (no modal — unlike a transfer pair there is no
 * second half to inspect before deciding).
 */
const RecurringControls = ({ onConfirm, onDismiss }: Props) => {
  return (
    <div className="recurringControls">
      <span className="recurringChip suggested">Recurring</span>
      <button className="recurringConfirm" onClick={() => void onConfirm()}>
        Confirm
      </button>
      <button className="recurringDismiss" onClick={() => void onDismiss()}>
        Dismiss
      </button>
    </div>
  );
};

export default RecurringControls;
