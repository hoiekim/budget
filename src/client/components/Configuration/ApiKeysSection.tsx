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

const formatDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString() : "Never";

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

      {error && (
        <div className="property">
          <div className="row">
            <span className="apiKeyError">{error}</span>
          </div>
        </div>
      )}

      {justCreated && (
        <>
          <div className="propertyLabel">New&nbsp;Key&nbsp;—&nbsp;Save&nbsp;Now</div>
          <div className="property apiKeyCopyOnce">
            <div className="row">
              <span className="apiKeyCopyOnceTitle">
                Copy this key — it will not be shown again.
              </span>
            </div>
            <div className="row keyValue">
              <span className="propertyName">Key</span>
              <code className="apiKeyPlaintext">{justCreated.plaintext}</code>
            </div>
            <div className="row button">
              <button type="button" onClick={onCopy}>
                Copy&nbsp;to&nbsp;clipboard
              </button>
            </div>
            <div className="row button">
              <button type="button" onClick={() => setJustCreated(null)}>
                I&rsquo;ve&nbsp;saved&nbsp;it
              </button>
            </div>
          </div>
        </>
      )}

      <div className="property">
        <div className="row keyValue">
          <span className="propertyName">Name</span>
          <input
            type="text"
            placeholder="e.g. claoie-suggester"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={creating}
            maxLength={255}
          />
        </div>
        <div className="row keyValue">
          <span className="propertyName">Scope</span>
          <select value={scope} onChange={(e) => setScope(e.target.value)} disabled={creating}>
            {SCOPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="row button">
          <button type="button" onClick={onCreate} disabled={creating || !name.trim()}>
            {creating ? "Creating…" : "Create Key"}
          </button>
        </div>
      </div>

      {loading && (
        <div className="property">
          <div className="row">
            <span className="propertyName disabled">Loading&hellip;</span>
          </div>
        </div>
      )}

      {!loading && keys.length === 0 && (
        <div className="property">
          <div className="row">
            <span className="propertyName disabled">No active API keys</span>
          </div>
        </div>
      )}

      {keys.map((k) => (
        <div className="property" key={k.key_id}>
          <div className="row keyValue">
            <span className="propertyName">Name</span>
            <span>{k.name}</span>
          </div>
          <div className="row keyValue">
            <span className="propertyName">Prefix</span>
            <code className="apiKeyPrefix">{k.key_prefix}…</code>
          </div>
          <div className="row keyValue">
            <span className="propertyName">Scopes</span>
            <span>{k.scopes.join(", ")}</span>
          </div>
          <div className="row keyValue">
            <span className="propertyName">Created</span>
            <span>{formatDate(k.created_at)}</span>
          </div>
          <div className="row keyValue">
            <span className="propertyName">Last&nbsp;Used</span>
            <span>{formatDate(k.last_used_at)}</span>
          </div>
          <div className="row button">
            <button
              type="button"
              className="delete colored"
              onClick={() => onRevoke(k.key_id, k.name)}
            >
              Revoke
            </button>
          </div>
        </div>
      ))}
    </>
  );
};
