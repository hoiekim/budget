import { useState, useContext } from "react";
import { MaskedUser } from "server";
import { Context, call, useSync } from "client";

const LoginInterface = () => {
  const { user, setUser } = useContext(Context);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const { clean } = useSync();

  const onClick = () => {
    if (user) {
      call<MaskedUser>("/api/login", { method: "DELETE" }).then((r) => {
        setUser(r.data);
        clean();
      });
    } else {
      call<MaskedUser>("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      }).then((r) => {
        if (r.status === "success") {
          setUser(r.data);
          setUsername("");
          setPassword("");
        }
      });
    }
  };

  if (!user) {
    return (
      <div className="LoginInterface">
        <div>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyUp={(e) => e.key === "Enter" && onClick()}
          ></input>
        </div>
        <div>
          <input
            value={password}
            type="password"
            onChange={(e) => setPassword(e.target.value)}
            onKeyUp={(e) => e.key === "Enter" && onClick()}
          ></input>
        </div>
        <div>
          <button onClick={onClick}>Login</button>
        </div>
      </div>
    );
  }

  return (
    <div className="LoginInterface">
      <div>{user.username} is logged in</div>
      <div>
        <button onClick={onClick}>Logout</button>
      </div>
    </div>
  );
};

export default LoginInterface;
