import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { MaskedUser } from "server";
import { call } from "client";
import { App } from "client/components";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

call.get<MaskedUser>("/api/login").then((r) => {
  root.render(
    <React.StrictMode>
      <App initialUser={r.data} />
    </React.StrictMode>
  );
});
