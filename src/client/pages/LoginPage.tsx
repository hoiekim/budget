import { useEffect, useState, FormEvent } from "react";
import { LoginPostResponse } from "server";
import { SSO_ERROR_PARAM, SsoError } from "common";
import { useAppContext, call, PATH } from "client";

const SSO_ERROR_MESSAGES: Record<SsoError, string> = {
  [SsoError.AccountExists]:
    "An account with your username already exists here and is not linked to your SSO account. Ask the administrator to link it.",
  [SsoError.NoAccess]: "Your SSO account does not have access to this app.",
  [SsoError.Expired]: "The sign-in took too long or was started elsewhere. Please try again.",
  [SsoError.Unavailable]: "The sign-in service is unavailable. Please try again later.",
  [SsoError.Failed]: "SSO sign-in failed. Please try again.",
};

const isSsoError = (code: string): code is SsoError =>
  (Object.values(SsoError) as string[]).includes(code);

const ssoErrorMessage = (code: string | null): string => {
  if (code === null) return "";
  return SSO_ERROR_MESSAGES[isSsoError(code) ? code : SsoError.Failed];
};

const signInWithSso = () => {
  const returnTo = encodeURIComponent(`/${PATH.BUDGETS}`);
  window.location.assign(`/api/auth/login?returnTo=${returnTo}`);
};

export const LoginPage = () => {
  const { user, setUser, router, sso } = useAppContext();
  const { path, go } = router;

  useEffect(() => {
    if (user && path === PATH.LOGIN) go(PATH.BUDGETS);
  }, [user, path, go]);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const shownError =
    errorMessage || ssoErrorMessage(router.getActiveParams(PATH.LOGIN).get(SSO_ERROR_PARAM));
  const errorRow = shownError && <div className="LoginPage-error">{shownError}</div>;

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
      {sso.enabled && (
        <div>
          <button type="button" onClick={signInWithSso}>
            Sign in with SSO
          </button>
        </div>
      )}
      {sso.localLogin ? (
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
          {errorRow}
          <div>
            <button type="submit" disabled={isLoading}>
              {isLoading ? "Logging in..." : "Login"}
            </button>
          </div>
        </form>
      ) : (
        errorRow
      )}
    </div>
  );
};
