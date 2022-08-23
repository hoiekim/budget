import { ReactNode, useEffect, useState } from "react";
import { PlaidLinkOnSuccessMetadata, usePlaidLink } from "react-plaid-link";
import { Item, PbulicTokenPostResponse, LinkTokenGetResponse } from "server";
import { useAppContext, call, useSync } from "client";

interface Props {
  item?: Item;
  children?: ReactNode;
}

const globalTokens = new Map<string, string>();
const fetchJobs = new Map<string, Promise<string>>();

const PlaidLinkButton = ({ item, children }: Props) => {
  const { user } = useAppContext();

  const access_token = item && item.access_token;
  const [token, setToken] = useState(() => {
    if (!access_token) return "";
    const existingToken = globalTokens.get(access_token);
    return existingToken || "";
  });

  const { sync } = useSync();

  const { open, ready } = usePlaidLink({
    token,
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
            user?.items.push(data.item);
            sync.transactions();
            sync.accounts();
          }
        });
    },
  });

  const userLoggedIn = !!user;
  const updateMode = !!item;
  const disabled = !ready;

  useEffect(() => {
    if (!userLoggedIn) {
      setToken("");
      return;
    }

    if (token) return;
    if (access_token && fetchJobs.has(access_token)) {
      fetchJobs.get(access_token)?.then((r) => {
        const globalToken = globalTokens.get(access_token);
        if (globalToken) setToken(globalToken);
      });
      return;
    }

    let queryString: string = "";
    if (updateMode && access_token) {
      queryString += "?" + new URLSearchParams({ access_token }).toString();
    }

    const promisedToken = call
      .get<LinkTokenGetResponse>("/api/link-token" + queryString)
      .then((r) => {
        const token = r.data || "";
        if (access_token) globalTokens.set(access_token, token);
        setToken(token);
        return token;
      });

    if (!access_token) return;
    fetchJobs.set(access_token, promisedToken);
  }, [token, userLoggedIn, updateMode, access_token]);

  return (
    <button onClick={() => open()} disabled={disabled}>
      {children}
    </button>
  );
};

export default PlaidLinkButton;
