import { ItemProvider, ItemStatus, toUpperCamelCase } from "common";
import { PublicTokenPostResponse } from "server";
import {
  Data,
  Item,
  ItemDictionary,
  call,
  InstitutionSpan,
  PATH,
  PlaidLinkButton,
  useAppContext,
  useSync,
  indexedDb,
  Properties,
  PropertyLabel,
  Property,
  Row,
} from "client";
import { SimpleFinLinkButton } from "client/components";
import { ApiKeysSection } from "./ApiKeysSection";
import "./index.css";

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
        params.append("item_id", id);
        go(PATH.CONNECTION_DETAIL, { params });
      };
      const buttonClassNames = ["connection"];
      if (status !== ItemStatus.OK) buttonClassNames.push("notification");
      return (
        <Row className="button" key={id}>
          <button className={buttonClassNames.join(" ")} onClick={onClickConnection}>
            <div>
              {institution_id ? (
                <InstitutionSpan institution_id={institution_id} />
              ) : (
                <span>{id.slice(0, 6).toUpperCase()}</span>
              )}
              <span className="small">&nbsp;&nbsp;via&nbsp;{toUpperCamelCase(provider)}</span>
            </div>
          </button>
        </Row>
      );
    });

  const { clean, sync } = useSync();

  const logout = () => {
    call
      .delete("/api/login")
      .then((r) => {
        if (r.status === "success" || r.status === "failed") {
          // Clear local state even if server reports failure
          setUser(undefined);
          clean();
        } else {
          console.error("Logout failed:", r.message);
        }
      })
      .catch((error) => {
        console.error("Logout request failed:", error);
        // Still clear local state on network error
        setUser(undefined);
        clean();
      });
  };

  const onClickRefresh = async () => {
    await clean();
    await sync();
  };

  const onClickAddManualAccount = async () => {
    const manualItem = items.find((item) => item.provider === ItemProvider.MANUAL);
    if (manualItem) {
      const clientPathParams = new URLSearchParams();
      clientPathParams.append("item_id", manualItem.id);
      go(PATH.CONNECTION_DETAIL, { params: clientPathParams });
    } else {
      const params = new URLSearchParams({ provider: ItemProvider.MANUAL });
      const { body } = await call.post<PublicTokenPostResponse>(
        `/api/public-token?${params.toString()}`,
        {},
      );
      if (!body) return;
      const { item } = body;
      const newItem = new Item(item);
      setData((oldData) => {
        const newData = new Data(oldData);
        indexedDb.save(newItem).catch(console.error);
        const newItems = new ItemDictionary(newData.items);
        newItems.set(newItem.id, newItem);
        newData.items = newItems;
        return newData;
      });
      const clientPathParams = new URLSearchParams();
      clientPathParams.append("item_id", newItem.id);
      go(PATH.CONNECTION_DETAIL, { params: clientPathParams });
    }
  };

  return (
    <Properties className="Configuration">
      <PropertyLabel>Manual&nbsp;Accounts</PropertyLabel>
      <Property>
        <Row className="button">
          <button onClick={onClickAddManualAccount}>See&nbsp;Manual&nbsp;Accounts</button>
        </Row>
      </Property>
      {!!itemsRow.length && (
        <>
          <PropertyLabel>Connections</PropertyLabel>
          <Property>{itemsRow}</Property>
        </>
      )}
      <PropertyLabel>Add&nbsp;Connection</PropertyLabel>
      <Property>
        <Row className="button">
          <PlaidLinkButton>Connect&nbsp;via&nbsp;Plaid</PlaidLinkButton>
        </Row>
        <Row className="button">
          <SimpleFinLinkButton>Connect&nbsp;via&nbsp;SimpleFin</SimpleFinLinkButton>
        </Row>
      </Property>
      <ApiKeysSection />
      <PropertyLabel>&nbsp;</PropertyLabel>
      <Property>
        <Row className="button">
          <button onClick={onClickRefresh}>Refresh</button>
        </Row>
        <Row className="button">
          <button className="delete colored" onClick={logout}>
            Logout
          </button>
        </Row>
      </Property>
    </Properties>
  );
};
