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
  DeleteButton,
  InstitutionSpan,
  KeyValue,
  PlaidLinkButton,
  Properties,
  PropertyLabel,
  Property,
  Row,
  useAppContext,
  indexedDb,
  StoreName,
} from "client";
import { ConnectedAccountRow } from "./ConnectedAccountRow";

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
        <PropertyLabel key={`${id}_label`}>{propertyLabel}</PropertyLabel>,
        <ConnectedAccountRow key={id} item={item} account={account} />,
      ];
    });

  const onClickRemove: MouseEventHandler<HTMLButtonElement> = (e) => {
    e.stopPropagation();

    const confirmed = window.confirm("Do you want to remove all data in this connection?");

    if (confirmed) {
      const { item_id } = item;
      call
        .delete(`/api/item?id=${item_id}`)
        .then((r) => {
          if (r.status === "success") {
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
          } else {
            console.error("Failed to delete connection:", r.message);
          }
        })
        .catch((error) => {
          console.error("Failed to delete connection:", error);
        });
    }
  };

  const onClickAddManualAccount: MouseEventHandler<HTMLButtonElement> = async (e) => {
    e.stopPropagation();
    const newAccountGraphOptions: AccountGraphOptions = {
      useSnapshots: true,
      useHoldingSnapshots: true,
      useTransactions: false,
    };
    const newAccount = new Account({ item_id: item.id, graphOptions: newAccountGraphOptions });
    try {
      const { status, body, message } = await call.post<AccountPostResponse>(
        "/api/account",
        newAccount,
      );
      if (status === "success" && body) {
        setData((oldData) => {
          const newData = new Data(oldData);
          indexedDb.save(newAccount).catch(console.error);
          const newAccounts = new AccountDictionary(newData.accounts);
          newAccounts.set(newAccount.id, newAccount);
          newData.accounts = newAccounts;
          return newData;
        });
      } else {
        console.error("Failed to add manual account:", message);
      }
    } catch (error) {
      console.error("Failed to add manual account:", error);
    }
  };

  return (
    <Properties className="ConnectionProperties">
      <PropertyLabel>Connection&nbsp;Detail</PropertyLabel>
      <Property>
        {!!institution_id && (
          <KeyValue name="Institution">
            <InstitutionSpan institution_id={institution_id} />
          </KeyValue>
        )}
        <KeyValue name="Last&nbsp;Updated">
          <span>{updated || "Unknown"}</span>
        </KeyValue>
        <KeyValue name="Status">
          <span>{status ? toTitleCase(status) : "Unknown"}</span>
        </KeyValue>
        <KeyValue name="Connection&nbsp;Provider">
          <span>{toUpperCamelCase(provider)}</span>
        </KeyValue>
      </Property>
      {accountRows}
      <PropertyLabel>&nbsp;</PropertyLabel>
      <Property>
        {provider === ItemProvider.PLAID && (
          <Row className="button">
            <PlaidLinkButton item={item}>Update</PlaidLinkButton>
          </Row>
        )}
        {provider === ItemProvider.MANUAL ? (
          <Row className="button">
            <button onClick={onClickAddManualAccount}>Add&nbsp;Account</button>
          </Row>
        ) : (
          <Row className="button">
            <DeleteButton onClick={onClickRemove}>Delete</DeleteButton>
          </Row>
        )}
      </Property>
    </Properties>
  );
};
