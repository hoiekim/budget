import {
  call,
  cleanCache,
  InstitutionSpan,
  PATH,
  PlaidLinkButton,
  useAppContext,
  useSync,
} from "client";
import { SimpleFinLinkButton } from "client/components";

import "./index.css";

const Configuration = () => {
  const { setUser, data, router } = useAppContext();

  const { items } = data;
  const { go } = router;

  const itemsRow = items.toArray().map(({ id, institution_id }) => {
    const onClickConnection = () => {
      const params = new URLSearchParams();
      params.append("id", id);
      go(PATH.CONNECTION_DETAIL, { params });
    };
    return (
      <div className="row button" key={id}>
        <button className="connection" onClick={onClickConnection}>
          <div>
            <InstitutionSpan institution_id={institution_id} />
            <span className="small">&nbsp;&nbsp;via&nbsp;Plaid</span>
          </div>
          <span>〉</span>
        </button>
      </div>
    );
  });

  const { clean, sync } = useSync();

  const logout = () => {
    call.delete("/api/login").then((r) => {
      setUser(undefined);
      clean();
    });
  };

  const onClickRefresh = () => {
    cleanCache();
    clean();
    sync.all();
  };

  return (
    <div className="Configuration Properties">
      {!!itemsRow.length && (
        <>
          <div className="propertyLabel">Connections</div>
          <div className="property">{itemsRow}</div>
        </>
      )}
      <div className="propertyLabel">Add&nbsp;Connection</div>
      <div className="property">
        <div className="row button">
          <PlaidLinkButton>Connect&nbsp;via&nbsp;Plaid</PlaidLinkButton>
        </div>
        <div className="row button">
          <SimpleFinLinkButton>Connect&nbsp;via&nbsp;SimpleFin</SimpleFinLinkButton>
        </div>
      </div>
      <div className="propertyLabel">&nbsp;</div>
      <div className="property">
        <div className="row button">
          <button onClick={onClickRefresh}>Refresh</button>
        </div>
        <div className="row button">
          <button className="delete colored" onClick={logout}>
            Logout
          </button>
        </div>
      </div>
    </div>
  );
};

export default Configuration;
