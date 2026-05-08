import { useCallback, useEffect, useState } from "react";
import type { ApiKeyJSON } from "server";
import { call, PATH, useAppContext } from "client";

import "./index.css";

type KeyView = Omit<ApiKeyJSON, "key_hash" | "revoked_at">;

const formatDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString() : "Never";

export const ApiKeyDetailPage = () => {
  const { router } = useAppContext();
  const { path, params, transition } = router;
  const activeParams = path === PATH.API_KEY_DETAIL ? params : transition.incomingParams;
  const keyId = activeParams.get("key_id") || "";

  const [apiKey, setApiKey] = useState<KeyView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!keyId) return;
    setLoading(true);
    setError(null);
    const r = await call.get<{ api_keys: KeyView[] }>("/api/api-keys");
    if (r.status === "success" && r.body) {
      const found = r.body.api_keys.find((k) => k.key_id === keyId);
      setApiKey(found ?? null);
      if (!found) setError("API key not found.");
    } else {
      setError(r.message ?? "Failed to load API key");
    }
    setLoading(false);
  }, [keyId]);

  useEffect(() => {
    load();
  }, [load]);

  const goBack = () => router.go(PATH.CONFIG);

  const onRevoke = async () => {
    if (!apiKey) return;
    if (!window.confirm(`Revoke API key "${apiKey.name}"? This cannot be undone.`)) return;
    const r = await call.delete<{ revoked: boolean }>(
      `/api/api-keys?key_id=${encodeURIComponent(apiKey.key_id)}`,
    );
    if (r.status === "success") {
      goBack();
    } else {
      setError(r.message ?? "Failed to revoke API key");
    }
  };

  if (!keyId) {
    return (
      <div className="ApiKeyDetailPage Properties">
        <div className="propertyLabel">API&nbsp;Key</div>
        <div className="property">
          <div className="row">
            <span className="propertyName disabled">Missing key id.</span>
          </div>
          <div className="row button">
            <button type="button" onClick={goBack}>
              Back
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (loading && !apiKey) {
    return (
      <div className="ApiKeyDetailPage Properties">
        <div className="propertyLabel">API&nbsp;Key</div>
        <div className="property">
          <div className="row">
            <span className="propertyName disabled">Loading&hellip;</span>
          </div>
        </div>
      </div>
    );
  }

  if (error || !apiKey) {
    return (
      <div className="ApiKeyDetailPage Properties">
        <div className="propertyLabel">API&nbsp;Key</div>
        <div className="property">
          <div className="row">
            <span className="propertyName disabled">{error ?? "Not found"}</span>
          </div>
          <div className="row button">
            <button type="button" onClick={goBack}>
              Back
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ApiKeyDetailPage Properties">
      <div className="propertyLabel">API&nbsp;Key&nbsp;Details</div>
      <div className="property">
        <div className="row keyValue">
          <span className="propertyName">Name</span>
          <span>{apiKey.name}</span>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Prefix</span>
          <code className="apiKeyPrefix">{apiKey.key_prefix}…</code>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Scopes</span>
          <span>{apiKey.scopes.join(", ")}</span>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Created</span>
          <span>{formatDate(apiKey.created_at)}</span>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Last&nbsp;Used</span>
          <span>{formatDate(apiKey.last_used_at)}</span>
        </div>
        {apiKey.expires_at && (
          <div className="row keyValue">
            <span className="propertyName">Expires</span>
            <span>{formatDate(apiKey.expires_at)}</span>
          </div>
        )}
      </div>
      <div className="property">
        <div className="row button">
          <button type="button" className="delete colored" onClick={onRevoke}>
            Revoke
          </button>
        </div>
        <div className="row button">
          <button type="button" onClick={goBack}>
            Back
          </button>
        </div>
      </div>
    </div>
  );
};
