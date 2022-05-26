import { useState, useContext } from "react";
import { call } from "lib";
import { Context } from "App";

const LoginInterface = () => {
  const { user, setUser } = useContext(Context);

  const [password, setPassword] = useState("");
  const onClick = () => {
    call("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }).then((r) => setUser(r.data));
  };
  if (!user) {
    return (
      <div className="LoginInterface">
        <input
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
          }}
        ></input>
        <button onClick={onClick}>Login</button>
      </div>
    );
  }
  return <div className="LoginInterface">{user.username} is logged in</div>;
};

export default LoginInterface;
