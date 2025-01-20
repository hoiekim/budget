import { call, cleanCache, InstitutionSpan, PlaidLinkButton, useAppContext, useSync } from "client";

import "./index.css";

interface Props {}

const Configuration = ({}: Props) => {
  const { user, setUser, data } = useAppContext();

  const { items } = data;

  const itemsRow = items.toArray().map(({ id, institution_id }) => {
    return (
      <div className="row keyValue" key={id}>
        <span className="propertyName">Institution</span>
        <InstitutionSpan institution_id={institution_id} />
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
          <div className="propertyLabel">Current&nbsp;Connections</div>
          <div className="property">{itemsRow}</div>
        </>
      )}
      <div className="propertyLabel">Add&nbsp;Connections</div>
      <div className="property">
        <div className="row button">
          <PlaidLinkButton>with&nbsp;Plaid</PlaidLinkButton>
        </div>
        <div className="row">
          <button disabled onClick={() => {}}>
            with&nbsp;Simple&nbsp;Fin
          </button>
        </div>
      </div>
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
