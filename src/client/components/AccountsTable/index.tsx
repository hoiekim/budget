import { CSSProperties, ReactNode, useState } from "react";
import { AccountType } from "plaid";
import { Account, DonutData, useAppContext } from "client";
import AccountRow from "./AccountRow";

export type AccountHeaders = { [k in keyof Account]?: boolean } & {
  institution?: boolean;
  budget?: boolean;
  action?: boolean;
};

interface Props {
  donutData: DonutData[];
  style?: CSSProperties;
}

export const AccountsTable = ({ donutData, style }: Props) => {
  const { data } = useAppContext();
  const { accounts } = data;

  // Hidden + Archived both sit behind their own "Show … (N)" toggle.
  //   - Hide  = Plaid duplicate-data shadow; the user wants this row OUT
  //     of normal view AND OUT of transfer-detection candidate selection.
  //   - Archive = "I'm done using this account but its history still
  //     counts in budget calc."
  // Same UI shape for both so the user doesn't have to learn two
  // patterns. Re-archiving / re-hiding happens via the per-account
  // detail page (AccountProperties), so no bulk "Unhide all" needed.
  const [showArchived, setShowArchived] = useState(false);
  const [showHidden, setShowHidden] = useState(false);

  const donutAccounts: ReactNode[] = donutData.map(({ id, color }) => {
    const account = accounts.get(id);
    if (!account) return <></>;
    return <AccountRow key={id} account={account} color={color} />;
  });

  const creditAccounts: ReactNode[] = [];
  const archivedAccounts: ReactNode[] = [];
  const hiddenAccounts: ReactNode[] = [];
  let archivedCount = 0;
  let hiddenCount = 0;

  accounts.forEach((a) => {
    if (a.hide) {
      hiddenCount++;
      hiddenAccounts.push(<AccountRow key={a.account_id} account={a} />);
      return;
    }
    if (a.archived) {
      archivedCount++;
      archivedAccounts.push(<AccountRow key={a.account_id} account={a} />);
      return;
    }
    const element = <AccountRow key={a.account_id} account={a} />;
    if (a.type === AccountType.Credit) creditAccounts.push(element);
  });

  return (
    <div className="AccountsTable" style={style}>
      {!!donutAccounts.length && <div className="rows">{donutAccounts}</div>}
      {!!creditAccounts.length && <div className="rows">{creditAccounts}</div>}
      {archivedCount > 0 && (
        <div>
          <button onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? "Hide" : "Show"}&nbsp;archived&nbsp;({archivedCount})
          </button>
          {showArchived && <div className="rows">{archivedAccounts}</div>}
        </div>
      )}
      {hiddenCount > 0 && (
        <div>
          <button onClick={() => setShowHidden((v) => !v)}>
            {showHidden ? "Hide" : "Show"}&nbsp;hidden&nbsp;({hiddenCount})
          </button>
          {showHidden && <div className="rows">{hiddenAccounts}</div>}
        </div>
      )}
      {!accounts.size && (
        <div className="placeholder">
          You don't have any connected accounts! Click this button to connect your accounts.
        </div>
      )}
    </div>
  );
};

export * from "./Balance";
