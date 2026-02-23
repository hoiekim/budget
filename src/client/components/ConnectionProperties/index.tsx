import { MouseEventHandler } from "react";
import { AccountGraphOptions, ItemProvider, toTitleCase, toUpperCamelCase } from "common";
import { AccountPostResponse } from "server";
import {
  Account,
  AccountDictionary,
  Data,
  Item,
  ItemDictionary,
  TransactionDictionary,
  call,
  InstitutionSpan,
  PlaidLinkButton,
  useAppContext,
  indexedDb,
  StoreName,
} from "client";
import { ConnectedAccountRow } from "./ConnectedAccountRow";
import "./index.css";

interface Props {
  item: Item;
}

export const ConnectionProperties = ({ item }: Props) => {
  const { data, setData, router } = useAppContext();
  const { accounts } = data;
  const { institution_id, status, updated, provider } = item;

  const accountRows = accounts
    .filter(({ item_id }) => item_id === item.id)
    .flatMap((account, i, { length }) => {
      const { id } = account;
      const isManualItem = item.provider === ItemProvider.MANUAL;
      let propertyLabel = isManualItem ? "Manual Account" : "Connected Account";
      if (length > 1) propertyLabel += ` ${i + 1}`;
      return [
        <div className="propertyLabel" key={`${id}_label`}>
          {propertyLabel}
        </div>,
        <ConnectedAccountRow key={id} item={item} account={account} />,
      ];
    });

  const onClickRemove: MouseEventHandler<HTMLButtonElement> = (e) => {
    e.stopPropagation();

    const confirmed = window.confirm("Do you want to remove all data in this connection?");

    if (confirmed) {
      const { item_id } = item;
      call.delete(`/api/item?id=${item_id}`).then((_r) => {
        const accountsInItem: Account[] = [];

        setData((oldData) => {
          const newData = new Data(oldData);

          const newItems = new ItemDictionary(newData.items);
          indexedDb.remove(StoreName.items, item_id).catch(console.error);
          newItems.delete(item_id);
          newData.items = newItems;

          const newAccounts = new AccountDictionary(newData.accounts);
          newAccounts.forEach((e) => {
            if (e.item_id === item_id) accountsInItem.push(e);
          });
          accountsInItem.forEach((e) => {
            indexedDb.remove(StoreName.accounts, e.account_id).catch(console.error);
            newAccounts.delete(e.account_id);
          });
          newData.accounts = newAccounts;

          const newTransactions = new TransactionDictionary(newData.transactions);
          newTransactions.forEach((e) => {
            if (accountsInItem.find((f) => e.account_id === f.account_id)) {
              indexedDb.remove(StoreName.transactions, e.transaction_id).catch(console.error);
              newTransactions.delete(e.transaction_id);
            }
          });
          newData.transactions = newTransactions;
          return newData;
        });

        router.back();
      });
    }
  };

  const onClickAddManualAccount: MouseEventHandler<HTMLButtonElement> = async (e) => {
    e.stopPropagation();
    const newAccountGraphOptions: AccountGraphOptions = {
      useSnapshots: true,
      useTransactions: false,
    };
    const newAccount = new Account({ item_id: item.id, graphOptions: newAccountGraphOptions });
    const { status, body } = await call.post<AccountPostResponse>("/api/account", newAccount);
    if (status === "success" && body) {
      setData((oldData) => {
        const newData = new Data(oldData);
        indexedDb.save(newAccount).catch(console.error);
        const newAccounts = new AccountDictionary(newData.accounts);
        newAccounts.set(newAccount.id, newAccount);
        newData.accounts = newAccounts;
        return newData;
      });
    }
  };

  return (
    <div className="ConnectionProperties Properties">
      <div className="propertyLabel">Connection&nbsp;Detail</div>
      <div className="property">
        {!!institution_id && (
          <div className="row keyValue">
            <span className="propertyName">Institution</span>
            <InstitutionSpan institution_id={institution_id} />
          </div>
        )}
        <div className="row keyValue">
          <span className="propertyName">Last&nbsp;Updated</span>
          <span>{updated || "Unknown"}</span>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Status</span>
          <span>{status ? toTitleCase(status) : "Unknown"}</span>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Connection&nbsp;Provider</span>
          <span>{toUpperCamelCase(provider)}</span>
        </div>
      </div>
      {accountRows}
      <div className="propertyLabel">&nbsp;</div>
      <div className="property">
        {provider === ItemProvider.PLAID && (
          <div className="row button">
            <PlaidLinkButton item={item}>Update</PlaidLinkButton>
          </div>
        )}
        {provider === ItemProvider.MANUAL ? (
          <div className="row button">
            <button onClick={onClickAddManualAccount}>Add&nbsp;Account</button>
          </div>
        ) : (
          <div className="row button">
            <button className="delete colored" onClick={onClickRemove}>
              Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
