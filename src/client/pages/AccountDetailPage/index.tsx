import { useEffect, useState } from "react";
import { Account } from "common";
import { useAppContext, PATH } from "client";
import { AccountProperties } from "client/components";

import "./index.css";

export type AccountDetailPageParams = {
  id?: string;
};

export const AccountDetailPage = () => {
  const { data, router } = useAppContext();
  const { accounts } = data;

  const { path, params, transition } = router;
  let id: string;
  if (path === PATH.ACCOUNT_DETAIL) id = params.get("account_id") || "";
  else id = transition.incomingParams.get("account_id") || "";

  const defaultAccount = accounts.get(id);
  const [account, setAccount] = useState<Account | undefined>(defaultAccount);

  useEffect(() => {
    const newAccount = accounts.get(id);
    setAccount((oldAccount) => (newAccount && new Account(newAccount)) || oldAccount);
  }, [id, accounts, setAccount]);

  if (!account) return <></>;
  return (
    <div className="AccountDetailPage">
      <AccountProperties account={account} />
    </div>
  );
};
