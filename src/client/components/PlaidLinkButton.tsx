import { MouseEventHandler, ReactNode, useEffect, useState } from "react";
import { ItemProvider, ItemStatus } from "common";
import { PublicTokenPostResponse, LinkTokenGetResponse } from "server";
import {
  Data,
  Item,
  ItemDictionary,
  useAppContext,
  call,
  useSync,
  useLocalStorageState,
  indexedDb,
} from "client";
import { usePlaidLinkContext, PlaidLinkOnSuccessMetadata } from "./PlaidLinkContext";

interface Props {
  item?: Item;
  children?: ReactNode;
}

const tokens = new Map<string, string>();
const promisedTokens = new Map<string, Promise<string>>();

export const PlaidLinkButton = ({ item, children }: Props) => {
  const { user, setData } = useAppContext();
  const { scriptLoaded, openLink } = usePlaidLinkContext();

  // The link token is cached per item. The key is the item_id — the item's
  // server-side credential never leaves the server (hoiekim/budget#807).
  const item_id = (item && item.item_id) || "";
  const [token, setToken] = useState(tokens.get(item_id) || "");
  const [storedToken, setStoredToken] = useLocalStorageState("storedToken", "");

  const { sync } = useSync();

  const urlParams = new URLSearchParams(window.location.search);
  const oauth_state_id = urlParams.get("oauth_state_id");

  const userLoggedIn = !!user;
  const effectiveToken = oauth_state_id ? storedToken : token;
  const disabled = !scriptLoaded || !effectiveToken;

  const handleSuccess = (public_token: string, metadata: PlaidLinkOnSuccessMetadata) => {
    const { institution } = metadata;
    const institution_id = institution && institution.institution_id;
    const params = new URLSearchParams({ provider: ItemProvider.PLAID });
    call
      .post<PublicTokenPostResponse>(`/api/public-token?${params.toString()}`, {
        public_token,
        institution_id,
      })
      .then((r) => {
        const { status, body } = r;
        if (status === "success" && body?.item) {
          if (item) {
            setData((oldData) => {
              const newData = new Data(oldData);
              const newItems = new ItemDictionary(newData.items);
              const newItem = new Item({ ...item, status: ItemStatus.OK });
              indexedDb.save(newItem).catch(console.error);
              newItems.set(item.item_id, newItem);
              newData.items = newItems;
              return newData;
            });
          }
          setTimeout(sync, 1000);
        }
      });
  };

  useEffect(() => {
    if (!userLoggedIn) {
      setToken("");
      return;
    }

    if (oauth_state_id || tokens.has(item_id)) return;

    if (promisedTokens.has(item_id)) {
      promisedTokens.get(item_id)?.then((_r) => {
        const existingToken = tokens.get(item_id);
        if (existingToken) setToken(existingToken);
      });
      return;
    }

    let queryString: string = "";
    if (item_id) {
      queryString += "?" + new URLSearchParams({ item_id }).toString();
    }

    const promisedToken = call
      .get<LinkTokenGetResponse>("/api/link-token" + queryString)
      .then((r) => {
        const token = r.body || "";
        tokens.set(item_id, token);
        setToken(token);
        return token;
      });

    promisedTokens.set(item_id, promisedToken);
  }, [token, userLoggedIn, item_id, oauth_state_id]);

  const onClick: MouseEventHandler<HTMLButtonElement> = (e) => {
    e.stopPropagation();
    if (!effectiveToken) return;
    setStoredToken(effectiveToken);
    openLink({
      token: effectiveToken,
      receivedRedirectUri: oauth_state_id ? window.location.href : undefined,
      onSuccess: handleSuccess,
    });
  };

  const className = disabled || !item || item.status === ItemStatus.OK ? "" : "notification";

  return (
    <button onClick={onClick} disabled={disabled} className={className}>
      {children}
    </button>
  );
};
