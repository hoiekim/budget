import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { App, call, User } from "client";

const root = ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement
);

call<User>("/api/login").then((r) => {
  root.render(
    <React.StrictMode>
      <App initialUser={r.data} />
    </React.StrictMode>
  );
});
