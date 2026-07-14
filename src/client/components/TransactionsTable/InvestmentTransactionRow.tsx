import { InvestmentTransaction, PATH, useAppContext } from "client";
import { InstitutionSpan, TransactionRowInfo } from "client/components";

interface Props {
  investmentTransaction: InvestmentTransaction;
}

const InvestmentTransactionRow = ({ investmentTransaction }: Props) => {
  const { id, account_id, date, name, amount, iso_currency_code } = investmentTransaction;

  const { data, router } = useAppContext();
  const { accounts } = data;
  const { go } = router;

  const account = accounts.get(account_id);
  const institution_id = account?.institution_id;

  const onClickInfo = () => {
    const params = new URLSearchParams(router.params);
    // Clear the sibling id so navigating inv-tx → tx → inv-tx doesn't
    // leave a stale transaction_id in the URL that would win the branch
    // in `TransactionDetailPage` (which now must pick one of two ids).
    params.delete("transaction_id");
    params.set("investment_transaction_id", id);
    go(PATH.TRANSACTION_DETAIL, { params });
  };

  return (
    <div className="TransactionRow">
      <TransactionRowInfo
        date={date}
        amount={amount}
        isoCurrency={iso_currency_code || ""}
        onClickInfo={onClickInfo}
      >
        {name && <div className="smallText">{name}</div>}
        <div className="bigText">{account?.custom_name || account?.name}</div>
        <div className="smallText">
          {institution_id && <InstitutionSpan institution_id={institution_id} />}
        </div>
      </TransactionRowInfo>
    </div>
  );
};

export default InvestmentTransactionRow;
