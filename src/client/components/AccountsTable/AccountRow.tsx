import { Account, ItemProvider } from "common";
import { useAppContext, DateLabel, MoneyLabel, useAccountGraph, PATH } from "client";
import { InstitutionSpan, Graph, Balance } from "client/components";
import "./index.css";
import { AccountType } from "plaid";

interface Props {
  account: Account;
}

const AccountRow = ({ account }: Props) => {
  const { router, data } = useAppContext();
  const { account_id, balances, custom_name, name, institution_id, type, subtype, graphOptions } =
    account;

  const { items } = data;
  const item = items.get(account.item_id);
  const isManualAccount = item?.provider === ItemProvider.MANUAL;

  const { iso_currency_code, unofficial_currency_code } = balances;
  const currencyCode = iso_currency_code || unofficial_currency_code || "USD";

  const { graphViewDate, graphData } = useAccountGraph([account], graphOptions);
  const showGraph = type === AccountType.Depository || type === AccountType.Investment;

  const onClickAccount = () => {
    const params = new URLSearchParams();
    params.set("id", account_id);
    router.go(PATH.ACCOUNT_DETAIL, { params });
  };

  return (
    <div className="AccountRow" onClick={onClickAccount}>
      <div className="AccountTitle">
        <span>{custom_name || name}</span>
        {isManualAccount ? (
          <span>Manual</span>
        ) : (
          <InstitutionSpan institution_id={institution_id} />
        )}
      </div>
      <Balance balances={balances} type={type} subtype={subtype} />
      {showGraph && !!graphData.lines && (
        <Graph
          input={graphData}
          labelX={new DateLabel(graphViewDate)}
          labelY={new MoneyLabel(currencyCode)}
          memoryKey={account_id}
        />
      )}
    </div>
  );
};

export default AccountRow;
