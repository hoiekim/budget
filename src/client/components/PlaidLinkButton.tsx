import { ReactNode, useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
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
  const [token, setToken] = useState(globalTokens.get(access_token || "") || "");

  const { sync } = useSync();

  const { open, ready } = usePlaidLink({
    token,
    onSuccess: (token: string) => {
      call.post<PbulicTokenResponse>("/api/public-token", { token }).then((r) => {
        const { status, data } = r;
        if (status === "success" && data?.item) {
          user?.items.push(data.item);
          sync();
        }
      });
    },
  });

  const userLoggedIn = !!user;
  const updateMode = item?.plaidError?.error_code === "ITEM_LOGIN_REQUIRED";
  const disabled = !token || !ready || (!!item && !updateMode);

  useEffect(() => {
    if (!userLoggedIn) {
      setToken("");
      return;
    }

    if (token || fetchJobs.has(access_token || "")) return;

    let queryString: string = "";
    if (updateMode && access_token) {
      queryString += "?" + new URLSearchParams({ access_token }).toString();
    }

    const promisedToken = call.get<string>("/api/link-token" + queryString).then((r) => {
      const token = r.data || "";
      globalTokens.set(access_token || "", token);
      setToken(token);
      return token;
    });

    fetchJobs.set(access_token || "", promisedToken);
  }, [token, userLoggedIn, updateMode, access_token]);

  return (
    <button onClick={() => open()} disabled={disabled}>
      {children}
    </button>
  );
};

export default PlaidLinkButton;
