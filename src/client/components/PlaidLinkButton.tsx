import { useEffect, useState, useContext } from "react";
import { usePlaidLink } from "react-plaid-link";
import { Context, call } from "client";

const PlaidLinkButton = () => {
  const { user } = useContext(Context);
  const [token, setToken] = useState("");

  useEffect(() => {
    call<string>("/api/link-token").then((r) => {
      setToken(r.data || "");
    });
  }, [user]);

  const { open, ready } = usePlaidLink({
    token,
    onSuccess: (token) => {
      call("/api/public-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
    },
  });

  return (
    <div className="PlaidLinkButton">
      <button onClick={() => open()} disabled={!ready}>
        Connect a bank account
      </button>
    </div>
  );
};

export default PlaidLinkButton;
