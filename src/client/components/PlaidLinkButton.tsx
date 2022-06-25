import { useEffect, useState, useContext } from "react";
import { usePlaidLink } from "react-plaid-link";
import { Context, call, useSync } from "client";

interface Props {
  token: string;
}

const Button = ({ token }: Props) => {
  const { sync } = useSync();

  const onSuccess = (token: Props["token"]) => {
    call.post("/api/public-token", { token }).then((r) => {
      if (r.status === "success") sync();
    });
  };

  const { open, ready } = usePlaidLink({
    token,
    onSuccess,
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
    call.get<string>("/api/link-token").then((r) => {
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
