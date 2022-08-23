import { Transaction } from "server";
import { Sorter } from "client";
import { TransactionHeaders } from ".";

interface Props {
  sorter: Sorter<Transaction, TransactionHeaders>;
  getHeader: (key: keyof TransactionHeaders) => string;
}

const TransactionsHead = ({ sorter, getHeader }: Props) => {
  const { setSortBy, getArrow, getVisible, toggleVisible } = sorter;

  type HeaderComponentProps = { field: keyof TransactionHeaders };

  const HeaderComponent = ({ field }: HeaderComponentProps) => {
    return (
      <div>
        <button onClick={() => setSortBy(field)}>
          {getHeader(field)} {getArrow(field)}
        </button>
        <button onClick={() => toggleVisible(field)}>✕</button>
      </div>
    );
  };

  return (
    <div>
      <div>
        {getVisible("authorized_date") && (
          <div>
            <HeaderComponent field="authorized_date" />
          </div>
        )}
        {getVisible("merchant_name") && (
          <div>
            <HeaderComponent field="merchant_name" />
          </div>
        )}
        {getVisible("amount") && (
          <div>
            <HeaderComponent field="amount" />
          </div>
        )}
      </div>
      <div>
        {getVisible("account") && (
          <div>
            <HeaderComponent field="account" />
          </div>
        )}
        {getVisible("budget") && (
          <div>
            <HeaderComponent field="budget" />
          </div>
        )}
        {getVisible("category") && (
          <div>
            <HeaderComponent field="category" />
          </div>
        )}
      </div>
    </div>
  );
};

export default TransactionsHead;
