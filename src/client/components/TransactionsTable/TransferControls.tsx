import { useState } from "react";
import { TransferPairModal } from "client/components";

interface Props {
  onConfirm: () => Promise<void>;
  onReject: () => Promise<void>;
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

  return (
    <div className="transferControls">
      <button className="transferChip suggested" onClick={() => setIsModalOpen(true)}>
        Transfer
      </button>
      {isModalOpen && (
        <TransferPairModal
          onConfirm={onConfirm}
          onReject={onReject}
          onClose={() => setIsModalOpen(false)}
        />
      )}
    </div>
  );
};

export default TransferControls;
