import { useEffect, useState, useContext } from "react";
import { usePlaidLink } from "react-plaid-link";
import { call } from "lib";
import { Context } from "App";

const Link = () => {
  const { user } = useContext(Context);
  const [token, setToken] = useState("");

  useEffect(() => {
    call("/api/link-token").then((r) => {
      setToken(r.data);
    });
  }, [user]);

  const { open, ready } = usePlaidLink({
    token,
    onSuccess: (token, metadata) => {
      call("/api/public-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
    },
  });

  return (
    <div className="Link">
      <button onClick={() => open()} disabled={!ready}>
        Connect a bank account
      </button>
    </div>
  );
};

export default Link;
