import { useEffect, useState } from "react";
import { Transaction } from "common";
import { useAppContext, PATH } from "client";
import { Configuration } from "client/components";

import "./index.css";

const ConfigPage = () => {
  const { data, router } = useAppContext();

  const { path, params, transition } = router;

  return (
    <div className="ConfigPage">
      <Configuration />
    </div>
  );
};

export default ConfigPage;
