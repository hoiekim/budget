import { PATH, useAppContext } from "client";
import { Account, Item, ItemProvider, toTitleCase } from "common";
import { MouseEventHandler } from "react";

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
    <div className="property">
      <div className="row keyValue">
        <span className="propertyName">Name</span>
        <span>{custom_name || name}</span>
      </div>
      <div className="row keyValue">
        <span className="propertyName">Type</span>
        <span>{toTitleCase(type)}</span>
      </div>
      {!isManualItem && !!subtype && (
        <div className="row keyValue">
          <span className="propertyName">Subtype</span>
          <span>{toTitleCase(subtype)}</span>
        </div>
      )}
      <div className="row button">
        <button onClick={onClickDetails}>See&nbsp;Details</button>
      </div>
    </div>
  );
};
