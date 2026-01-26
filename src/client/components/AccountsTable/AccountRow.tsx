import { AccountType } from "plaid";
import { Account, ItemProvider } from "common";
import { useAppContext, useAccountGraph, PATH, NoLabel } from "client";
import { InstitutionSpan, Graph } from "client/components";
import { Balance } from "./Balance";
import "./index.css";

interface Props {
  account: Account;
}

const AccountRow = ({ account }: Props) => {
  const { router, data } = useAppContext();
  const { account_id, balances, custom_name, name, institution_id, type, subtype } = account;

  const { items } = data;
  const item = items.get(account.item_id);
  const isManualAccount = item?.provider === ItemProvider.MANUAL;

  const { graphData } = useAccountGraph([account]);
  const showGraph = type === AccountType.Depository || type === AccountType.Investment;

  const onClickAccount = () => {
    const params = new URLSearchParams();
    params.set("account_id", account_id);
    router.go(PATH.ACCOUNT_DETAIL, { params });
  };

  const noLabel = new NoLabel();

  if (showGraph && !!graphData.lines) {
    return (
      <div className="AccountRow threeChildren" onClick={onClickAccount}>
        <div className="accountTitle">
          <div>{custom_name || name}</div>
          <div>
            {isManualAccount ? (
              <span>Manual</span>
            ) : (
              <InstitutionSpan institution_id={institution_id} />
            )}
          </div>
        </div>
        {showGraph && !!graphData.lines && (
          <div className="graphContainer">
            <Graph
              height={50}
              input={{ ...graphData, points: undefined }}
              labelX={noLabel}
              labelY={noLabel}
              memoryKey={`small_${account_id}`}
            />
          </div>
        )}
        <Balance balances={balances} type={type} subtype={subtype} />
      </div>
    );
  }

  return (
    <div className="AccountRow twoChildren" onClick={onClickAccount}>
      <div className="accountTitle">
        <div>{custom_name || name}</div>
        <div>
          {isManualAccount ? (
            <span>Manual</span>
          ) : (
            <InstitutionSpan institution_id={institution_id} />
          )}
        </div>
      </div>
      <Balance balances={balances} type={type} subtype={subtype} />
    </div>
  );
};

export default AccountRow;
