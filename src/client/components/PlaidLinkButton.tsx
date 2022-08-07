import { ReactNode, useEffect, useState } from "react";
import { PlaidLinkOnSuccessMetadata, usePlaidLink } from "react-plaid-link";
import { Item, PbulicTokenResponse } from "server";
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
        .post<PbulicTokenResponse>("/api/public-token", { public_token, institution_id })
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
  const error_code = item?.plaidError?.error_code;
  const updateMode = error_code === "ITEM_LOGIN_REQUIRED";
  if (!updateMode && error_code) {
    console.warn(`Unhandled plaidError: ${error_code}`);
  }
  const disabled = !token || !ready || (!!item && !updateMode);

  useEffect(() => {
    if (!userLoggedIn) {
      setToken("");
      return;
    }

    if (token || fetchJobs.has(access_token || "")) return;
    if (!updateMode && access_token) return;

    let queryString: string = "";
    if (updateMode && access_token) {
      queryString += "?" + new URLSearchParams({ access_token }).toString();
    }

    const promisedToken = call.get<string>("/api/link-token" + queryString).then((r) => {
      const token = r.data || "";
      if (access_token) globalTokens.set(access_token, token);
      setToken(token);
      return token;
    });

    if (access_token) fetchJobs.set(access_token, promisedToken);
  }, [token, userLoggedIn, updateMode, access_token]);

  return (
    <button onClick={() => open()} disabled={disabled}>
      {children}
    </button>
  );
};

export default PlaidLinkButton;
