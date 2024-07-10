import { MouseEventHandler, ReactNode, useEffect, useState } from "react";
import { PlaidLinkOnSuccessMetadata, usePlaidLink } from "react-plaid-link";
import { PbulicTokenPostResponse, LinkTokenGetResponse } from "server";
import { useAppContext, call, useSync, useLocalStorage } from "client";
import { Item, ItemStatus } from "common";

interface Props {
  item?: Item;
  children?: ReactNode;
}

const tokens = new Map<string, string>();
const promisedTokens = new Map<string, Promise<string>>();

const PlaidLinkButton = ({ item, children }: Props) => {
  const { user, data } = useAppContext();

  const access_token = (item && item.access_token) || "";
  const [token, setToken] = useState(tokens.get(access_token) || "");
  const [storedToken, setStoredToken] = useLocalStorage("storedToken", "");

  const { sync } = useSync();

  const urlParams = new URLSearchParams(window.location.search);
  const oauth_state_id = urlParams.get("oauth_state_id");

  const { open, ready } = usePlaidLink({
    token: oauth_state_id ? storedToken : token,
    receivedRedirectUri: oauth_state_id ? window.location.href : undefined,
    onSuccess: (public_token: string, metadata: PlaidLinkOnSuccessMetadata) => {
      const { institution } = metadata;
      const institution_id = institution && institution.institution_id;
      call
        .post<PbulicTokenPostResponse>("/api/public-token", {
          public_token,
          institution_id,
        })
        .then((r) => {
          const { status, body } = r;
          if (status === "success" && body?.item) {
            if (item) {
              const newItem = new Item({ ...item, status: ItemStatus.OK });
              data.items.set(item.item_id, newItem);
            }
            setTimeout(() => {
              sync.transactions();
              sync.accounts();
            }, 1000);
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

  const className = !disabled && item?.status === ItemStatus.BAD ? "notification" : undefined;

  return (
    <button onClick={onClick} disabled={disabled} className={className}>
      {children}
    </button>
  );
};

export default PlaidLinkButton;
