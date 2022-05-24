import { useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";

const Link = () => {
  const [token, setToken] = useState("");
  useEffect(() => {
    fetch("/api/link-token")
      .then((r) => r.json())
      .then((r) => {
        console.log(r);
        setToken(r.data);
      });
  }, []);
  const { open, ready } = usePlaidLink({
    token,
    onSuccess: (token, metadata) => {
      fetch("/api/public-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      })
        .then((r) => r.json())
        .then(console.log);
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
