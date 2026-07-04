import { numberToCommaString, currencyCodeToSymbol, LocalDate } from "common";
import { InvestmentTransaction, PATH, useAppContext } from "client";
import { InstitutionSpan, KebabIcon } from "client/components";

interface Props {
  investmentTransaction: InvestmentTransaction;
  isEditable?: boolean;
}

const InvestmentTransactionRow = ({ investmentTransaction, isEditable = false }: Props) => {
  const { id, account_id, date, name, amount, iso_currency_code } = investmentTransaction;

  const { data, router } = useAppContext();
  const { accounts } = data;
  const { go } = router;

  const account = accounts.get(account_id);
  const institution_id = account?.institution_id;

  const onClickKebab = () => {
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
      <div className="transactionInfo">
        <div className="authorized_date bigText">
          {new LocalDate(date).toLocaleString("en-US", {
            month: "numeric",
            day: "numeric",
          })}
        </div>
        <div className="merchant_name">
          {name && <div className="smallText">{name}</div>}
          <div className="bigText">{account?.custom_name || account?.name}</div>
          <div className="smallText">
            {institution_id && <InstitutionSpan institution_id={institution_id} />}
          </div>
        </div>
        <div className="amount">
          {amount < 0 && <>+&nbsp;</>}
          {currencyCodeToSymbol(iso_currency_code || "")}&nbsp;
          {numberToCommaString(Math.abs(amount))}
        </div>
      </div>
      {isEditable && (
        <div className="budgetCategoryActions">
          <div>
            <button className="kebabButton" onClick={onClickKebab}>
              <KebabIcon size={15} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default InvestmentTransactionRow;
