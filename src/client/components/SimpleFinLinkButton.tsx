import { ReactNode } from "react";
import { useAppContext, call, useSync } from "client";
import { Data, Item, ItemDictionary, ItemProvider, ItemStatus } from "common";
import { PbulicTokenPostResponse } from "server";

interface Props {
  children?: ReactNode;
}

const SimpleFinLinkButton = ({ children }: Props) => {
  const { setData } = useAppContext();
  const { sync } = useSync();

  const onClick = () => {
    const public_token = prompt("Enter setup token");
    const params = new URLSearchParams({ provider: ItemProvider.SIMPLE_FIN });
    call
      .post<PbulicTokenPostResponse>(`/api/public-token?${params.toString()}`, {
        public_token,
      })
      .then((r) => {
        const { status, body } = r;
        if (status === "success" && body?.item) {
          const item = body.item;
          setData((oldData) => {
            const newData = new Data(oldData);
            const newItems = new ItemDictionary(newData.items);
            const newItem = new Item({ ...item, status: ItemStatus.OK });
            newItems.set(item.item_id, newItem);
            newData.items = newItems;
            return newData;
          });
          setTimeout(() => {
            sync.accounts().then(sync.transactions);
          }, 1000);
        }
      });
  };

  return <button onClick={onClick}>{children}</button>;
};

export default SimpleFinLinkButton;
