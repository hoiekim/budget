import { useEffect, useState } from "react";
import { LoginPostResponse } from "server";
import { useAppContext, call, PATH } from "client";

const LoginPage = () => {
  const { user, setUser, router } = useAppContext();
  const { path, go } = router;

  useEffect(() => {
    if (user && path === PATH.LOGIN) go(PATH.BUDGETS);
  }, [user, path, go]);

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

  return (
    <div className="LoginPage">
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
};

export default LoginPage;
