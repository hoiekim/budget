import { useEffect, useState } from "react";
import { Item, PATH, useAppContext } from "client";
import { ConnectionProperties } from "client/components";
import "./index.css";

export const ConnectionDetailPage = () => {
  const { data, router } = useAppContext();
  const { items } = data;

  const { path, params, transition } = router;
  let id: string;
  if (path === PATH.CONNECTION_DETAIL) id = params.get("item_id") || "";
  else id = transition.incomingParams.get("item_id") || "";

  const defaultItem = items.get(id);
  const [item, setItem] = useState<Item | undefined>(defaultItem);

  useEffect(() => {
    const newItem = items.get(id);
    setItem((oldItem) => (newItem && new Item(newItem)) || oldItem);
  }, [id, items]);

  if (!item) return <></>;

  return (
    <div className="ConfigPage">
      <ConnectionProperties item={item} />
    </div>
  );
};
