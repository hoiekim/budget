import { Data, Item, ItemDictionary, ItemProvider, ItemStatus, toUpperCamelCase } from "common";
import {
  call,
  cleanCache,
  InstitutionSpan,
  PATH,
  PlaidLinkButton,
  useAppContext,
  useSync,
} from "client";
import { SimpleFinLinkButton } from "client/components";

import "./index.css";
import { PbulicTokenPostResponse } from "server";

export const Configuration = () => {
  const { setUser, data, setData, router } = useAppContext();

  const { items } = data;
  const { go } = router;

  const itemsRow = items
    .toArray()
    .filter(({ provider }) => provider !== ItemProvider.MANUAL)
    .map(({ id, institution_id, status, provider }) => {
      const onClickConnection = () => {
        const params = new URLSearchParams();
        params.append("id", id);
        go(PATH.CONNECTION_DETAIL, { params });
      };
      const buttonClassNames = ["connection"];
      if (status !== ItemStatus.OK) buttonClassNames.push("notification");
      return (
        <div className="row button" key={id}>
          <button className={buttonClassNames.join(" ")} onClick={onClickConnection}>
            <div>
              {!!institution_id ? (
                <InstitutionSpan institution_id={institution_id} />
              ) : (
                <span>{id.slice(0, 6).toUpperCase()}</span>
              )}
              <span className="small">&nbsp;&nbsp;via&nbsp;{toUpperCamelCase(provider)}</span>
            </div>
          </button>
        </div>
      );
    });

  const { clean, sync } = useSync();

  const logout = () => {
    call.delete("/api/login").then((r) => {
      setUser(undefined);
      clean();
    });
  };

  const onClickRefresh = async () => {
    clean();
    await cleanCache();
    await sync.all();
  };

  const onClickAddManualAccount = async () => {
    const manualItem = items.find((item) => item.provider === ItemProvider.MANUAL);
    if (manualItem) {
      const clientPathParams = new URLSearchParams();
      clientPathParams.append("id", manualItem.id);
      go(PATH.CONNECTION_DETAIL, { params: clientPathParams });
    } else {
      const params = new URLSearchParams({ provider: ItemProvider.MANUAL });
      const { body } = await call.post<PbulicTokenPostResponse>(
        `/api/public-token?${params.toString()}`,
        {}
      );
      if (!body) return;
      const { item } = body;
      const newItem = new Item(item);
      setData((oldData) => {
        const newData = new Data(oldData);
        const newItems = new ItemDictionary(newData.items);
        newItems.set(newItem.id, newItem);
        newData.items = newItems;
        return newData;
      });
      const clientPathParams = new URLSearchParams();
      clientPathParams.append("id", newItem.id);
      go(PATH.CONNECTION_DETAIL, { params: clientPathParams });
    }
  };

  return (
    <div className="Configuration Properties">
      <div className="propertyLabel">Manual&nbsp;Accounts</div>
      <div className="property">
        <div className="row button">
          <button onClick={onClickAddManualAccount}>See&nbsp;Manual&nbsp;Accounts</button>
        </div>
      </div>
      {!!itemsRow.length && (
        <>
          <div className="propertyLabel">Connections</div>
          <div className="property">{itemsRow}</div>
        </>
      )}
      <div className="propertyLabel">Add&nbsp;Connection</div>
      <div className="property">
        <div className="row button">
          <PlaidLinkButton>Connect&nbsp;via&nbsp;Plaid</PlaidLinkButton>
        </div>
        <div className="row button">
          <SimpleFinLinkButton>Connect&nbsp;via&nbsp;SimpleFin</SimpleFinLinkButton>
        </div>
      </div>
      <div className="propertyLabel">&nbsp;</div>
      <div className="property">
        <div className="row button">
          <button onClick={onClickRefresh}>Refresh</button>
        </div>
        <div className="row button">
          <button className="delete colored" onClick={logout}>
            Logout
          </button>
        </div>
      </div>
    </div>
  );
};
