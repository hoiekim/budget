import { ReactNode, useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { Item } from "server";
import { useAppContext, call, useSync } from "client";

interface Props {
  item?: Item;
  children?: ReactNode;
}

const PlaidLinkButton = ({ item, children }: Props) => {
  const { user } = useAppContext();
  const [token, setToken] = useState("");

  const { sync } = useSync();

  const { open, ready } = usePlaidLink({
    token,
    onSuccess: (token: string) => {
      call.post("/api/public-token", { token }).then((r) => {
        if (r.status === "success") sync();
      });
    },
  });

  const userLoggedIn = !!user;
  const access_token = item && item.access_token;
  const updateMode = item?.plaidError?.error_code === "ITEM_LOGIN_REQUIRED";
  const disabled = !token || !ready || (!!item && !updateMode);

  useEffect(() => {
    if (userLoggedIn) {
      let queryString: string = "";
      if (updateMode && access_token) {
        queryString += "?" + new URLSearchParams({ access_token }).toString();
      }
      call.get<string>("/api/link-token" + queryString).then((r) => {
        setToken(r.data || "");
      });
    } else {
      setToken("");
    }
  }, [userLoggedIn, updateMode, access_token]);

  return (
    <button onClick={() => open()} disabled={disabled}>
      {children}
    </button>
  );
};

export default PlaidLinkButton;
