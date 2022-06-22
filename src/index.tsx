import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { call, User } from "client";
import { App } from "client/components";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

call<User>("/api/login").then((r) => {
  root.render(
    <React.StrictMode>
      <App initialUser={r.data} />
    </React.StrictMode>
  );
});
