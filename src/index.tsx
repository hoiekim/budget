import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";

import { call } from "lib";

const root = ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement
);

call("/api/login").then((r) => {
  root.render(
    <React.StrictMode>
      <App initialUser={r.data} />
    </React.StrictMode>
  );
});
