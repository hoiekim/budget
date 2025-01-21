import { PATH, useAppContext } from "client";
import { ConnectionProperties } from "client/components";

import "./index.css";
import { useEffect, useState } from "react";
import { Item } from "common";

const ConnectionDetailPage = () => {
  const { data, router } = useAppContext();
  const { items } = data;

  const { path, params, transition } = router;
  let id: string;
  if (path === PATH.BUDGET_CONFIG) id = params.get("id") || "";
  else id = transition.incomingParams.get("id") || "";

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

export default ConnectionDetailPage;
