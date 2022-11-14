import { ReactNode, useEffect, useState } from "react";
import { PlaidLinkOnSuccessMetadata, usePlaidLink } from "react-plaid-link";
import { Item, PbulicTokenPostResponse, LinkTokenGetResponse } from "server";
import { useAppContext, call, useSync, useLocalStorage } from "client";

interface Props {
  item?: Item;
  children?: ReactNode;
}

const tokens = new Map<string, string>();
const promisedTokens = new Map<string, Promise<string>>();

const PlaidLinkButton = ({ item, children }: Props) => {
  const { user } = useAppContext();

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
          const { status, data } = r;
          if (status === "success" && data?.item) {
            sync.transactions();
            sync.accounts();
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
        const token = r.data || "";
        tokens.set(access_token, token);
        setToken(token);
        return token;
      });

    promisedTokens.set(access_token, promisedToken);
  }, [token, userLoggedIn, access_token]);

  const onClick = () => {
    if (!token) return;
    setStoredToken(token);
    open();
  };

  return (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
};

export default PlaidLinkButton;
