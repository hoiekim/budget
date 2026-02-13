import { MouseEventHandler, ReactNode, useEffect, useState } from "react";
import { PlaidLinkOnSuccessMetadata, usePlaidLink } from "react-plaid-link";
import { ItemProvider, ItemStatus } from "common";
import { PbulicTokenPostResponse, LinkTokenGetResponse } from "server";
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

interface Props {
  item?: Item;
  children?: ReactNode;
}

const tokens = new Map<string, string>();
const promisedTokens = new Map<string, Promise<string>>();

export const PlaidLinkButton = ({ item, children }: Props) => {
  const { user, setData } = useAppContext();

  const access_token = (item && item.access_token) || "";
  const [token, setToken] = useState(tokens.get(access_token) || "");
  const [storedToken, setStoredToken] = useLocalStorageState("storedToken", "");

  const { sync } = useSync();

  const urlParams = new URLSearchParams(window.location.search);
  const oauth_state_id = urlParams.get("oauth_state_id");

  const { open, ready } = usePlaidLink({
    token: oauth_state_id ? storedToken : token,
    receivedRedirectUri: oauth_state_id ? window.location.href : undefined,
    onSuccess: (public_token: string, metadata: PlaidLinkOnSuccessMetadata) => {
      const { institution } = metadata;
      const institution_id = institution && institution.institution_id;
      const params = new URLSearchParams({ provider: ItemProvider.PLAID });
      call
        .post<PbulicTokenPostResponse>(`/api/public-token?${params.toString()}`, {
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
    },
  });

  const userLoggedIn = !!user;
  const disabled = !ready;

  useEffect(() => {
    if (!userLoggedIn) {
      setToken("");
      return;
    }

    if (oauth_state_id || tokens.has(access_token)) return;

    if (promisedTokens.has(access_token)) {
      promisedTokens.get(access_token)?.then((r) => {
        const existingToken = tokens.get(access_token);
        if (existingToken) setToken(existingToken);
      });
      return;
    }

    let queryString: string = "";
    if (access_token) {
      queryString += "?" + new URLSearchParams({ access_token }).toString();
    }

    const promisedToken = call
      .get<LinkTokenGetResponse>("/api/link-token" + queryString)
      .then((r) => {
        const token = r.body || "";
        tokens.set(access_token, token);
        setToken(token);
        return token;
      });

    promisedTokens.set(access_token, promisedToken);
  }, [token, userLoggedIn, access_token, oauth_state_id]);

  const onClick: MouseEventHandler<HTMLButtonElement> = (e) => {
    e.stopPropagation();
    if (!token) return;
    setStoredToken(token);
    open();
  };

  const className = disabled || !item || item.status === ItemStatus.OK ? "" : "notification";

  return (
    <button onClick={onClick} disabled={disabled} className={className}>
      {children}
    </button>
  );
};
