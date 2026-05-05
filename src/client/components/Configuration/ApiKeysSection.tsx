import { useCallback, useEffect, useState } from "react";
import type { ApiKeyJSON } from "server";
import { call } from "client";

import "./ApiKeysSection.css";

const SCOPE_OPTIONS = [
  { value: "transactions:suggest", label: "Suggest transaction labels" },
];

type KeyView = Omit<ApiKeyJSON, "key_hash" | "revoked_at">;

interface CreateResult {
  key_id: string;
  prefix: string;
  plaintext: string;
}

export const ApiKeysSection = () => {
  const [keys, setKeys] = useState<KeyView[]>([]);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");
  const [scope, setScope] = useState(SCOPE_OPTIONS[0].value);
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState<CreateResult | null>(null);
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

  const onCreate = async () => {
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    setCreating(true);
    setError(null);
    const r = await call.post<CreateResult>("/api/api-keys", {
      name: name.trim(),
      scopes: [scope],
    });
    setCreating(false);
    if (r.status === "success" && r.body) {
      setJustCreated(r.body);
      setName("");
      load();
    } else {
      setError(r.message ?? "Failed to create API key");
    }
  };

  const onRevoke = async (key_id: string, label: string) => {
    if (!window.confirm(`Revoke API key "${label}"? This cannot be undone.`)) return;
    const r = await call.delete<{ revoked: boolean }>(
      `/api/api-keys?key_id=${encodeURIComponent(key_id)}`,
    );
    if (r.status === "success") load();
    else setError(r.message ?? "Failed to revoke API key");
  };

  const onCopy = () => {
    if (!justCreated) return;
    navigator.clipboard?.writeText(justCreated.plaintext).catch(() => undefined);
  };

  return (
    <>
      <div className="propertyLabel">API&nbsp;Keys</div>
      <div className="property ApiKeysSection">
        {error && <div className="apiKeyError">{error}</div>}

        {justCreated && (
          <div className="apiKeyCopyOnce">
            <div className="apiKeyCopyOnceTitle">
              Copy this key — it will not be shown again:
            </div>
            <div className="apiKeyCopyOnceValue">
              <code>{justCreated.plaintext}</code>
              <button type="button" onClick={onCopy}>
                Copy
              </button>
            </div>
            <button
              type="button"
              className="apiKeyCopyOnceDismiss"
              onClick={() => setJustCreated(null)}
            >
              I&rsquo;ve&nbsp;saved&nbsp;it
            </button>
          </div>
        )}

        <div className="apiKeyCreateForm">
          <input
            type="text"
            placeholder="Name (e.g. claoie-suggester)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={creating}
            maxLength={255}
          />
          <select value={scope} onChange={(e) => setScope(e.target.value)} disabled={creating}>
            {SCOPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button type="button" onClick={onCreate} disabled={creating || !name.trim()}>
            {creating ? "Creating…" : "Create&nbsp;Key"}
          </button>
        </div>

        {loading && <div className="apiKeyHint">Loading&hellip;</div>}
        {!loading && keys.length === 0 && (
          <div className="apiKeyHint">No active API keys.</div>
        )}
        {keys.length > 0 && (
          <ul className="apiKeyList">
            {keys.map((k) => (
              <li key={k.key_id}>
                <div className="apiKeyMeta">
                  <span className="apiKeyName">{k.name}</span>
                  <span className="apiKeyPrefix">
                    <code>{k.key_prefix}…</code>
                  </span>
                  <span className="apiKeyScopes">{k.scopes.join(", ")}</span>
                  <span className="apiKeyDate">
                    created {new Date(k.created_at).toLocaleDateString()}
                    {k.last_used_at
                      ? ` · last used ${new Date(k.last_used_at).toLocaleDateString()}`
                      : " · never used"}
                  </span>
                </div>
                <button
                  type="button"
                  className="delete colored"
                  onClick={() => onRevoke(k.key_id, k.name)}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
};
