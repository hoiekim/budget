import { Transaction } from "server";
import { numberToCommaString, currencyCodeToSymbol } from "client";

interface Props {
  transaction: Transaction;
}

const TransactionItem = ({ transaction }: Props) => {
  const {
    authorized_date,
    date,
    merchant_name,
    name,
    amount,
    location,
    iso_currency_code,
  } = transaction;

  return (
    <div className="TransactionItem">
      <div>
        <div className="bigText">
          {new Date(authorized_date || date).toLocaleString("en-US", {
            year: undefined,
            month: "numeric",
            day: "numeric",
          })}
        </div>
      </div>
      <div>
        <div className="bigText">{merchant_name}</div>
        <div className="smallText">{name}</div>
        <div className="smallText">
          {[location.city, location.region].filter((e) => e).join(", ")}
        </div>
      </div>
      <div className="bigText">
        {currencyCodeToSymbol(iso_currency_code || "")}&nbsp;
        {numberToCommaString(amount)}
      </div>
    </div>
  );
};

export default TransactionItem;
