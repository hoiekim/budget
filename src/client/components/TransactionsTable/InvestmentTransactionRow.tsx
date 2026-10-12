import { InvestmentTransaction, PATH, useAppContext } from "client";
import { RightArrowIcon, TransactionRowInfo } from "client/components";
import { movesShares } from "common";
import { InvestmentTransactionType } from "plaid";

interface Props {
  investmentTransaction: InvestmentTransaction;
}

const InvestmentTransactionRow = ({ investmentTransaction }: Props) => {
  const { id, account_id, security_id, date, name, amount, iso_currency_code, label, type } =
    investmentTransaction;

  const { data, router } = useAppContext();
  const { accounts, securities } = data;
  const { go } = router;

  const account = accounts.get(account_id);

  const onClickInfo = () => {
    const params = new URLSearchParams(router.params);
    // Clear the sibling id so navigating inv-tx → tx → inv-tx doesn't
    // leave a stale transaction_id in the URL that would win the branch
    // in `TransactionDetailPage` (which now must pick one of two ids).
    params.delete("transaction_id");
    params.set("investment_transaction_id", id);
    go(PATH.TRANSACTION_DETAIL, { params });
  };

  if (movesShares(type)) {
    const security = security_id ? securities.get(security_id) : undefined;
    const holding = security?.ticker_symbol || security?.name || "Shares";
    const isBuy = type === InvestmentTransactionType.Buy;
    const [from, to] = isBuy ? ["Cash", holding] : [holding, "Cash"];
    return (
      <div className="TransactionRow">
        <TransactionRowInfo
          date={date}
          amount={amount}
          isoCurrency={iso_currency_code || ""}
          // A trade swaps cash for shares inside the account, so it is neither
          // money in nor money out.
          amountSign="none"
          onClickInfo={onClickInfo}
        >
          <div className="bigText">{isBuy ? "Buy" : "Sell"}</div>
          <div className="smallText">
            {from}
            &nbsp;
            <RightArrowIcon size={8} />
            &nbsp;
            {to}
          </div>
        </TransactionRowInfo>
      </div>
    );
  }

  return (
    <div className="TransactionRow">
      <TransactionRowInfo
        date={date}
        amount={amount}
        isoCurrency={iso_currency_code || ""}
        onClickInfo={onClickInfo}
      >
        <div className="bigText">{label.memo || name}</div>
        <div className="smallText">{account?.custom_name || account?.name}</div>
      </TransactionRowInfo>
    </div>
  );
};

export default InvestmentTransactionRow;
