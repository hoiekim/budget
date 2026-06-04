import { MouseEventHandler } from "react";
import { ItemProvider, toTitleCase } from "common";
import { Account, Item, PATH, Property, Row, useAppContext } from "client";

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
      <Row className="keyValue">
        <span className="propertyName">Name</span>
        <span>{custom_name || name}</span>
      </Row>
      <Row className="keyValue">
        <span className="propertyName">Type</span>
        <span>{toTitleCase(type)}</span>
      </Row>
      {!isManualItem && !!subtype && (
        <Row className="keyValue">
          <span className="propertyName">Subtype</span>
          <span>{toTitleCase(subtype)}</span>
        </Row>
      )}
      <Row className="button">
        <button onClick={onClickDetails}>See&nbsp;Details</button>
      </Row>
    </Property>
  );
};
