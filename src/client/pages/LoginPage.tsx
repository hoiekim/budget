import { useEffect, useState } from "react";
import { LoginPostResponse } from "server";
import { useAppContext, call, PATH } from "client";

const LoginPage = () => {
  const { user, setUser, router } = useAppContext();

  useEffect(() => {
    if (user && router) router.go(PATH.BUDGETS);
  }, [user, router]);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const onClick = () => {
    call.post<LoginPostResponse>("/api/login", { username, password }).then((r) => {
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
    <div className="LoginPage">
      <div>
        <span>{user.username} is logged in</span>
        <button onClick={onClick}>Logout</button>
      </div>
    </div>
  );
};

export default LoginPage;
