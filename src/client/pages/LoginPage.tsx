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
  const [errorMessage, setErrorMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setErrorMessage("");
    setIsLoading(true);
    call.post<LoginPostResponse>("/api/login", { username, password }).then((r) => {
      setIsLoading(false);
      if (r.status === "success") {
        setUser(r.body);
        setUsername("");
        setPassword("");
      } else {
        setErrorMessage(r.message || "Login failed. Please try again.");
      }
    }).catch(() => {
      setIsLoading(false);
      setErrorMessage("Network error. Please try again.");
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
            onChange={(e) => {
              setUsername(e.target.value);
              setErrorMessage("");
            }}
          />
        </div>
        <div>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setErrorMessage("");
            }}
          />
        </div>
        {errorMessage && <div className="LoginPage-error">{errorMessage}</div>}
        <div>
          <button type="submit" disabled={isLoading}>
            {isLoading ? "Logging in..." : "Login"}
          </button>
        </div>
      </form>
    </div>
  );
};
