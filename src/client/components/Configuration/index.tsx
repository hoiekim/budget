import { ItemProvider, ItemStatus, toUpperCamelCase } from "common";
import { ApiResponse, LoginDeleteResponse, PublicTokenPostResponse } from "server";
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
  DeleteButton,
  Properties,
  PropertyLabel,
  Property,
  ButtonRow,
  Row,
} from "client";
import { SimpleFinLinkButton } from "client/components";
import { ApiKeysSection } from "./ApiKeysSection";
import { SharingSection } from "./SharingSection";
import "./index.css";

export const Configuration = () => {
  const { user, setUser, data, setData, router } = useAppContext();

  const { items, sharing } = data;
  const { go } = router;

  const isOwn = (item: Item) => !item.user_id || item.user_id === user?.user_id;
  const ownerNameOf = (item: Item) =>
    sharing?.members.find((member) => member.user_id === item.user_id)?.username;

  const itemsRow = items
    .toArray()
    .filter((item) => item.provider !== ItemProvider.MANUAL || !isOwn(item))
    .map((item) => {
      const { id, institution_id, status, provider } = item;
      const ownerName = ownerNameOf(item);
      const onClickConnection = () => {
        const params = new URLSearchParams();
        params.append("item_id", id);
        go(PATH.CONNECTION_DETAIL, { params });
      };
      const buttonClassNames = ["connection"];
      if (status !== ItemStatus.OK) buttonClassNames.push("notification");
      return (
        <ButtonRow
          key={id}
          buttonClassName={buttonClassNames.join(" ")}
          onClick={onClickConnection}
        >
          <div>
            {provider === ItemProvider.MANUAL ? (
              <span>Manual&nbsp;Accounts</span>
            ) : (
              <>
                {institution_id ? (
                  <InstitutionSpan institution_id={institution_id} />
                ) : (
                  <span>{id.slice(0, 6).toUpperCase()}</span>
                )}
                <span className="small">&nbsp;&nbsp;via&nbsp;{toUpperCamelCase(provider)}</span>
              </>
            )}
          </div>
          {ownerName && <span className="small owner">{ownerName}</span>}
        </ButtonRow>
      );
    });

  const { clean, sync } = useSync();

  const logout = () => {
    fetch("/api/login", { method: "DELETE" })
      .then((httpResponse) => httpResponse.json() as Promise<ApiResponse<LoginDeleteResponse>>)
      .then(
        async (r) => {
          // Any answer from the server means it has cleared the session cookie, so the local state goes too.
          if (r.status !== "success") console.error("Logout failed:", r.message);
          setUser(undefined);
          await clean();
          // A single sign-on session also ends at the identity provider.
          const logoutUrl = r.body?.logoutUrl;
          if (logoutUrl) window.location.assign(logoutUrl);
        },
        (error) => {
          // No answer from the server: the session cookie is still valid, so stay signed in.
          console.error("Logout request failed:", error);
        },
      )
      .catch((error) => console.error("Logout cleanup failed:", error));
  };

  const onClickRefresh = async () => {
    await clean();
    await sync();
  };

  const onClickAddManualAccount = async () => {
    const manualItem = items.find((item) => item.provider === ItemProvider.MANUAL && isOwn(item));
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
        <ButtonRow onClick={onClickAddManualAccount}>See&nbsp;Manual&nbsp;Accounts</ButtonRow>
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
      <SharingSection />
      <ApiKeysSection />
      <PropertyLabel>&nbsp;</PropertyLabel>
      <Property>
        <ButtonRow onClick={onClickRefresh}>Refresh</ButtonRow>
        <Row className="button">
          <DeleteButton confirmMessage="Do you want to log out?" onClick={logout}>
            Logout
          </DeleteButton>
        </Row>
      </Property>
    </Properties>
  );
};
