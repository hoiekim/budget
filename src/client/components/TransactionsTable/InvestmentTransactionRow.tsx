import { numberToCommaString, currencyCodeToSymbol } from "common";
import { InvestmentTransaction, useAppContext } from "client";
import { InstitutionSpan } from "client/components";

interface Props {
  investmentTransaction: InvestmentTransaction;
}

const InvestmentTransactionRow = ({ investmentTransaction }: Props) => {
  const { account_id, date, name, amount, iso_currency_code } = investmentTransaction;

  const { data } = useAppContext();
  const { accounts } = data;

  const account = accounts.get(account_id);
  const institution_id = account?.institution_id;

  return (
    <div className="TransactionRow">
      <div className="transactionInfo">
        <div className="authorized_date bigText">
          {new Date(date).toLocaleString("en-US", {
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
    </div>
  );
};

export default InvestmentTransactionRow;
