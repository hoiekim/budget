import React from "react";
import ReactDOM from "react-dom/client";
import { LoginGetResponse } from "server";
import { call } from "client";
import { App } from "client/components";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

call.get<LoginGetResponse>("/api/login").then((r) => {
  const app = r.body?.app;
  const version = app?.version;
  if (version) {
    const appInfoString = localStorage.getItem("app");
    const appInfo = appInfoString ? JSON.parse(appInfoString) : undefined;
    const theVersionThatIUsedToKnow = appInfo?.version;
    if (theVersionThatIUsedToKnow !== version) {
      localStorage.clear();
      localStorage.setItem("app", JSON.stringify(app));
    }
  }
  root.render(
    <React.StrictMode>
      <App initialUser={r.body?.user} />
    </React.StrictMode>
  );
});

// Report unhandled JS errors to server
window.addEventListener("error", (event) => {
  const body = JSON.stringify({
    message: event.message,
    stack: event.error?.stack ?? "",
    url: window.location.href,
  });
  navigator.sendBeacon("/api/client-error", new Blob([body], { type: "application/json" }));
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  const body = JSON.stringify({
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? (reason.stack ?? "") : "",
    url: window.location.href,
  });
  navigator.sendBeacon("/api/client-error", new Blob([body], { type: "application/json" }));
});
