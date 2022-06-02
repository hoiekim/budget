import { useState, useContext } from "react";
import { Context, User, call } from "lib";

const LoginInterface = () => {
  const { user, setUser } = useContext(Context);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const onClick = () => {
    call<User>("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    }).then((r) => setUser(r.data));
  };
  if (!user) {
    return (
      <div className="LoginInterface">
        <div>
          <input
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
            }}
          ></input>
        </div>
        <div>
          <input
            value={password}
            type="password"
            onChange={(e) => setPassword(e.target.value)}
          ></input>
        </div>
        <div>
          <button onClick={onClick}>Login</button>
        </div>
      </div>
    );
  }
  return <div className="LoginInterface">{user.username} is logged in</div>;
};

export default LoginInterface;
