import { MouseEventHandler } from "react";
import { Account, AccountDictionary, Data, Item, toTitleCase, TransactionDictionary } from "common";
import { call, InstitutionSpan, PlaidLinkButton, useAppContext } from "client";

import "./index.css";

interface Props {
  item: Item;
}

const ConnectionProperties = ({ item }: Props) => {
  const { data, setData } = useAppContext();
  const { accounts, institutions } = data;

  const { institution_id, status, updated, provider } = item;

  const accountRows = accounts
    .toArray()
    .filter(({ item_id }) => {
      return item_id === item.id;
    })
    .map(({ id, name, custom_name, type, subtype }, i, { length }) => {
      const numbering = length > 1 ? <>&nbsp;{i + 1}</> : <></>;
      return (
        <>
          <div className="propertyLabel" key={`${id}_label`}>
            Connected&nbsp;Account&nbsp;{numbering}
          </div>
          <div className="property" key={id}>
            <div className="row keyValue">
              <span className="propertyName">Name</span>
              <span>{custom_name || name}</span>
            </div>
            <div className="row keyValue">
              <span className="propertyName">Type</span>
              <span>{type}</span>
            </div>
            <div className="row keyValue">
              <span className="propertyName">Subtype</span>
              <span>{subtype}</span>
            </div>
          </div>
        </>
      );
    });

  const institution = institutions.get(item.institution_id);

  const onClickRemove: MouseEventHandler<HTMLButtonElement> = (e) => {
    e.stopPropagation();

    const confirmed = window.confirm(
      `Do you want to remove all accounts in ${
        institution?.name || "Unknown"
      } institution from Budget?`
    );

    if (confirmed) {
      const { item_id } = item;
      call.delete(`/api/item?id=${item_id}`).then((r) => {
        const accountsInItem: Account[] = [];

        setData((oldData) => {
          const newData = new Data(oldData);

          const newAccounts = new AccountDictionary(newData.accounts);
          newAccounts.forEach((e) => {
            if (e.item_id === item_id) accountsInItem.push(e);
          });
          accountsInItem.forEach((e) => {
            newAccounts.delete(e.account_id);
          });
          newData.accounts = newAccounts;

          const newTransactions = new TransactionDictionary(newData.transactions);
          newTransactions.forEach((e) => {
            if (accountsInItem.find((f) => e.account_id === f.account_id)) {
              newTransactions.delete(e.transaction_id);
            }
          });
          newData.transactions = newTransactions;
          return newData;
        });
      });
    }
  };

  return (
    <div className="ConnectionProperties Properties">
      <div className="propertyLabel">Connection&nbsp;Detail</div>
      <div className="property">
        <div className="row keyValue">
          <span className="propertyName">Institution</span>
          <InstitutionSpan institution_id={institution_id} />
        </div>
        <div className="row keyValue">
          <span className="propertyName">Last&nbsp;Updated</span>
          <span>{updated || "Unknown"}</span>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Status</span>
          <span>{status || "Unknown"}</span>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Connection&nbsp;Provider</span>
          <span>{toTitleCase(provider)}</span>
        </div>
      </div>
      {accountRows}
      <div className="propertyLabel">&nbsp;</div>
      <div className="property">
        <div className="row button">
          <PlaidLinkButton item={item}>Update</PlaidLinkButton>
        </div>
        <div className="row button">
          <button className="delete colored" onClick={onClickRemove}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConnectionProperties;