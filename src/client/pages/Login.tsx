import { useEffect, useState } from "react";
import { MaskedUser } from "server";
import { useAppContext, call } from "client";

const Login = () => {
  const { user, setUser, router } = useAppContext();

  useEffect(() => {
    if (user && router) router.go("/");
  }, [user, router]);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const onClick = () => {
    call.post<MaskedUser>("/api/login", { username, password }).then((r) => {
      if (r.status === "success") {
        setUser(r.data);
        setUsername("");
        setPassword("");
      }
    });
  };

  if (!user) {
    return (
      <div className="Login">
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
    <div className="Login">
      <div>{user.username} is logged in</div>
      <div>
        <button onClick={onClick}>Logout</button>
      </div>
    </div>
  );
};

export default Login;
