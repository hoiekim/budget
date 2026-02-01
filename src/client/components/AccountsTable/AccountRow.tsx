import { AccountType } from "plaid";
import { ItemProvider } from "common";
import { Account, useAppContext, useAccountGraph, PATH, NoLabel } from "client";
import { InstitutionSpan, Graph } from "client/components";
import { Balance } from "./Balance";
import "./index.css";

interface Props {
  account: Account;
  color?: string;
}

const AccountRow = ({ account, color }: Props) => {
  const { router, data } = useAppContext();
  const { account_id, custom_name, name, institution_id, type } = account;

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
          <div className="colorTag colored" style={{ backgroundColor: color }} />
          <div className="textTag">
            <div>{custom_name || name}</div>
            <div>
              {isManualAccount ? (
                <span>Manual</span>
              ) : (
                <InstitutionSpan institution_id={institution_id} />
              )}
            </div>
          </div>
        </div>
        {showGraph && !!graphData.lines && (
          <div className="graphContainer">
            <Graph
              height={40}
              input={{ ...graphData, points: undefined }}
              labelX={noLabel}
              labelY={noLabel}
              memoryKey={`small_${account_id}`}
            />
          </div>
        )}
        <Balance account={account} />
      </div>
    );
  }

  return (
    <div className="AccountRow twoChildren" onClick={onClickAccount}>
      <div className="accountTitle">
        <div className="textTag">
          <div>{custom_name || name}</div>
          <div>
            {isManualAccount ? (
              <span>Manual</span>
            ) : (
              <InstitutionSpan institution_id={institution_id} />
            )}
          </div>
        </div>
      </div>
      <Balance account={account} />
    </div>
  );
};

export default AccountRow;
