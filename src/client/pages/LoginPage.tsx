import { useEffect, useState, FormEvent } from "react";
import { LoginPostResponse } from "server";
import { useAppContext, call, PATH } from "client";

export const LoginPage = () => {
  const { user, setUser, router } = useAppContext();
  const { path, go } = router;

  useEffect(() => {
    if (user && path === PATH.LOGIN) go(PATH.BUDGETS);
  }, [user, path, go]);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    call.post<LoginPostResponse>("/api/login", { username, password }).then((r) => {
      if (r.status === "success") {
        setUser(r.body);
        setUsername("");
        setPassword("");
      }
    });
  };

  return (
    <div className="LoginPage">
      <form onSubmit={onSubmit}>
        <div>
          <input
            name="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div>
          <button type="submit">Login</button>
        </div>
      </form>
    </div>
  );
};
