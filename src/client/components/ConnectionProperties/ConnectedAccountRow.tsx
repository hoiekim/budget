import { MouseEventHandler } from "react";
import { ItemProvider, toTitleCase } from "common";
import { Account, Item, KeyValue, PATH, Property, Row, useAppContext } from "client";

interface Props {
  item: Item;
  account: Account;
}

export const ConnectedAccountRow = ({ item, account }: Props) => {
  const { router } = useAppContext();

  const { account_id, name, custom_name, type, subtype } = account;

  const isManualItem = item.provider === ItemProvider.MANUAL;

  const onClickDetails: MouseEventHandler<HTMLButtonElement> = (e) => {
    e.stopPropagation();
    router.go(PATH.ACCOUNT_DETAIL, { params: new URLSearchParams({ account_id }) });
  };

  return (
    <Property>
      <KeyValue name="Name">
        <span>{custom_name || name}</span>
      </KeyValue>
      <KeyValue name="Type">
        <span>{toTitleCase(type)}</span>
      </KeyValue>
      {!isManualItem && !!subtype && (
        <KeyValue name="Subtype">
          <span>{toTitleCase(subtype)}</span>
        </KeyValue>
      )}
      <Row className="button">
        <button onClick={onClickDetails}>See&nbsp;Details</button>
      </Row>
    </Property>
  );
};
