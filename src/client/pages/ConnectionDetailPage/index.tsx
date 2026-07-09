import { useEffect, useState } from "react";
import { Item, PATH, useAppContext } from "client";
import { ConnectionProperties, PlaidLinkProvider } from "client/components";

export const ConnectionDetailPage = () => {
  const { data, router } = useAppContext();
  const { items } = data;

  const params = router.getActiveParams(PATH.CONNECTION_DETAIL);
  const id = params.get("item_id") || "";

  const defaultItem = items.get(id);
  const [item, setItem] = useState<Item | undefined>(defaultItem);

  useEffect(() => {
    const newItem = items.get(id);
    setItem((oldItem) => (newItem && new Item(newItem)) || oldItem);
  }, [id, items]);

  if (!item) return <></>;

  return (
    <PlaidLinkProvider>
      <div className="ConnectionDetailPage">
        <ConnectionProperties item={item} />
      </div>
    </PlaidLinkProvider>
  );
};
