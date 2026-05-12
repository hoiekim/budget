import { useCallback, useEffect, useState } from "react";
import type { ApiKeyJSON } from "server";
import { call, PATH, useAppContext } from "client";

import "./ApiKeysSection.css";

type KeyView = Omit<ApiKeyJSON, "key_hash" | "revoked_at">;

export const ApiKeysSection = () => {
  const { router } = useAppContext();
  const [keys, setKeys] = useState<KeyView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const r = await call.get<{ api_keys: KeyView[] }>("/api/api-keys");
    if (r.status === "success" && r.body) setKeys(r.body.api_keys);
    else setError(r.message ?? "Failed to load API keys");
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const goToKey = (keyId: string) => {
    const params = new URLSearchParams();
    params.set("key_id", keyId);
    router.go(PATH.API_KEY_DETAIL, { params });
  };

  const goToNewKey = () => {
    router.go(PATH.API_KEY_DETAIL);
  };

  return (
    <>
      <div className="propertyLabel">API&nbsp;Keys</div>

      {error && (
        <div className="property">
          <div className="row">
            <span className="apiKeyError">{error}</span>
          </div>
        </div>
      )}

      <div className="property">
        {loading && (
          <div className="row">
            <span className="propertyName disabled">Loading&hellip;</span>
          </div>
        )}
        {!loading && keys.length === 0 && (
          <div className="row">
            <span className="propertyName disabled">No active API keys</span>
          </div>
        )}
        {keys.map((k) => (
          <div className="row button" key={k.key_id}>
            <button className="connection" onClick={() => goToKey(k.key_id)}>
              <div>
                <span>{k.name}</span>
                <span className="small">&nbsp;&nbsp;{k.key_prefix}…</span>
              </div>
            </button>
          </div>
        ))}
        <div className="row button">
          <button type="button" onClick={goToNewKey}>
            Add
          </button>
        </div>
      </div>
    </>
  );
};
