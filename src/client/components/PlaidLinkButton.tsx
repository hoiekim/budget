import { useEffect, useState, useContext } from "react";
import { usePlaidLink } from "react-plaid-link";
import { Context, call } from "client";

interface Props {
  token: string;
}

const Button = ({ token }: Props) => {
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
    <button onClick={() => open()} disabled={!ready}>
      Connect a bank account
    </button>
  );
};

const PlaidLinkButton = () => {
  const { user } = useContext(Context);
  const [token, setToken] = useState("");

  useEffect(() => {
    call<string>("/api/link-token").then((r) => {
      setToken(r.data || "");
    });
  }, [user]);

  if (token) {
    return (
      <div className="PlaidLinkButton">
        <Button token={token} />
      </div>
    );
  }

  return (
    <div className="PlaidLinkButton">
      <button disabled={true}>Connect a bank account</button>
    </div>
  );
};

export default PlaidLinkButton;
