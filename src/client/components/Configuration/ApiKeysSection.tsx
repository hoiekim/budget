import { useCallback, useEffect, useState } from "react";
import type { ApiKeyJSON } from "server";
import {
  call,
  PATH,
  useAppContext,
  PropertyLabel,
  Property,
  ButtonRow,
  Row,
} from "client";

import "../ApiKeyProperties/index.css";

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
      <PropertyLabel>API&nbsp;Keys</PropertyLabel>

      {error && (
        <Property>
          <Row>
            <span className="apiKeyError">{error}</span>
          </Row>
        </Property>
      )}

      <Property>
        {loading && (
          <Row>
            <span className="propertyName disabled">Loading&hellip;</span>
          </Row>
        )}
        {!loading && keys.length === 0 && (
          <Row>
            <span className="propertyName disabled">No active API keys</span>
          </Row>
        )}
        {keys.map((k) => (
          <ButtonRow key={k.key_id} buttonClassName="connection" onClick={() => goToKey(k.key_id)}>
            <div>
              <span>{k.name}</span>
              <span className="small">&nbsp;&nbsp;{k.key_prefix}…</span>
            </div>
          </ButtonRow>
        ))}
        <ButtonRow type="button" onClick={goToNewKey}>
          Add
        </ButtonRow>
      </Property>
    </>
  );
};
