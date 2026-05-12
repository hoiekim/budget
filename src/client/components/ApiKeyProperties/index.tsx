import { useCallback, useEffect, useState } from "react";
import type { ApiKeyJSON } from "server";
import { call, PATH, useAppContext } from "client";

import "./index.css";

type KeyView = Omit<ApiKeyJSON, "key_hash" | "revoked_at">;

interface CreateResult {
  key_id: string;
  prefix: string;
  plaintext: string;
}

const SCOPE_OPTIONS = [
  { value: "transactions:suggest", label: "Suggest transaction labels" },
];

const formatDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString() : "Never";

export const ApiKeyProperties = () => {
  const { router } = useAppContext();
  const { path, params, transition } = router;
  const activeParams = path === PATH.API_KEY_DETAIL ? params : transition.incomingParams;
  const keyId = activeParams.get("key_id") || "";
  const isNew = !keyId;

  // ── Detail view (key_id set) ──────────────────────────────────────────
  const [apiKey, setApiKey] = useState<KeyView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Create form (key_id unset) ────────────────────────────────────────
  const [name, setName] = useState("");
  const [scope, setScope] = useState(SCOPE_OPTIONS[0].value);
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState<CreateResult | null>(null);

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
    if (!isNew) load();
  }, [isNew, load]);

  const goBack = () => router.go(PATH.CONFIG);

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
    } else {
      setError(r.message ?? "Failed to create API key");
    }
  };

  const onCopy = () => {
    if (!justCreated) return;
    navigator.clipboard?.writeText(justCreated.plaintext).catch(() => undefined);
  };

  const onSavedConfirm = () => {
    if (!justCreated) return;
    const next = new URLSearchParams();
    next.set("key_id", justCreated.key_id);
    router.go(PATH.API_KEY_DETAIL, { params: next });
  };

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

  // ── Just-created view (key_id unset + justCreated set) ───────────────
  if (isNew && justCreated) {
    return (
      <div className="ApiKeyProperties Properties">
        <div className="propertyLabel">New&nbsp;Key&nbsp;—&nbsp;Save&nbsp;Now</div>
        <div className="property">
          <div className="row">
            <span className="apiKeyCopyOnceTitle">
              Copy this key — it will not be shown again.
            </span>
          </div>
          <div className="row keyValue">
            <span className="propertyName">Key</span>
            <code className="apiKeyPlaintext">{justCreated.plaintext}</code>
          </div>
        </div>
        <div className="propertyLabel">&nbsp;</div>
        <div className="property">
          <div className="row button">
            <button type="button" className="colored" onClick={onCopy}>
              Copy&nbsp;to&nbsp;clipboard
            </button>
          </div>
          <div className="row button">
            <button type="button" onClick={onSavedConfirm}>
              I&rsquo;ve&nbsp;saved&nbsp;it
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Create form (key_id unset, no justCreated yet) ───────────────────
  if (isNew) {
    return (
      <div className="ApiKeyProperties Properties">
        <div className="propertyLabel">New&nbsp;API&nbsp;Key</div>
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
          {error && (
            <div className="row">
              <span className="apiKeyError">{error}</span>
            </div>
          )}
        </div>
        <div className="propertyLabel">&nbsp;</div>
        <div className="property">
          <div className="row button">
            <button
              type="button"
              className="colored"
              onClick={onCreate}
              disabled={creating || !name.trim()}
            >
              {creating ? "Creating…" : "Create Key"}
            </button>
          </div>
          <div className="row button">
            <button type="button" onClick={goBack}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Detail view loading state ────────────────────────────────────────
  if (loading && !apiKey) {
    return (
      <div className="ApiKeyProperties Properties">
        <div className="propertyLabel">API&nbsp;Key</div>
        <div className="property">
          <div className="row">
            <span className="propertyName disabled">Loading&hellip;</span>
          </div>
        </div>
      </div>
    );
  }

  // ── Detail view error / not-found ────────────────────────────────────
  if (error || !apiKey) {
    return (
      <div className="ApiKeyProperties Properties">
        <div className="propertyLabel">API&nbsp;Key</div>
        <div className="property">
          <div className="row">
            <span className="propertyName disabled">{error ?? "Not found"}</span>
          </div>
        </div>
        <div className="propertyLabel">&nbsp;</div>
        <div className="property">
          <div className="row button">
            <button type="button" onClick={goBack}>
              Back
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Detail view ──────────────────────────────────────────────────────
  return (
    <div className="ApiKeyProperties Properties">
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
      <div className="propertyLabel">&nbsp;</div>
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
