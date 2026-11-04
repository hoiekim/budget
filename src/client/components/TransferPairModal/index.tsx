import { Modal } from "client/components";
import "./index.css";

interface Props {
  /** A write is open for this pair. Both actions are inert while set. */
  busy: boolean;
  onConfirm: () => void;
  onReject: () => void;
  onClose: () => void;
}

/**
 * Confirm / reject dialog for a suggested transfer pair, opened from the
 * `Transfer` chip on a transactions row.
 *
 * Both outcomes are named buttons here rather than affordances on the row
 * itself: rejecting writes `status='rejected'`, which the detection engine
 * reads as a permanent per-pair denylist, so it must not be one click away
 * from a resting transactions list.
 *
 *     This transaction pair is auto-detected as a transfer
 *     [Confirm]  [Reject]
 *
 * Presentational: `busy` and the decision to close on a landed write both
 * belong to the owner, which outlives this component's dismissal.
 */
export const TransferPairModal = ({ busy, onConfirm, onReject, onClose }: Props) => {
  return (
    <Modal
      label="Transfer suggestion"
      title="Transfer"
      closeLabel="Close transfer suggestion"
      onClose={onClose}
      className="TransferPairModal"
    >
      <div className="message">This transaction pair is auto-detected as a transfer</div>
      {/* `aria-disabled`, not `disabled`: an element disabled while focused is
          blurred to the body, and this overlay is portalled last in `<body>`,
          so the next Tab would start above a dialog still declaring
          `aria-modal`. The owner's in-flight check is what refuses the click. */}
      <div className="actions">
        <button className="confirmButton" aria-disabled={busy} onClick={onConfirm}>
          Confirm
        </button>
        <button className="rejectButton" aria-disabled={busy} onClick={onReject}>
          Reject
        </button>
      </div>
    </Modal>
  );
};
