import { useCallback, useEffect, useState } from "react";
import type { ApiKeyJSON } from "server";
import {
  call,
  DeleteButton,
  KeyValue,
  PATH,
  Properties,
  Property,
  PropertyLabel,
  Row,
  useAppContext,
} from "client";
import "./index.css";

type KeyView = Omit<ApiKeyJSON, "key_hash" | "revoked_at">;

interface CreateResult {
  key_id: string;
  prefix: string;
  plaintext: string;
}

const SCOPE_OPTIONS = [{ value: "transactions:suggest", label: "Suggest transaction labels" }];

const formatDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString() : "Never";

export const ApiKeyProperties = () => {
  const { router } = useAppContext();
  const params = router.getActiveParams(PATH.API_KEY_DETAIL);
  const keyId = params.get("key_id") || "";
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
      <Properties className="ApiKeyProperties">
        <PropertyLabel>New&nbsp;Key&nbsp;—&nbsp;Save&nbsp;Now</PropertyLabel>
        <Property>
          <Row>
            <span className="apiKeyCopyOnceTitle">Copy this key — it will not be shown again.</span>
          </Row>
          <KeyValue name="Key">
            <code className="apiKeyPlaintext">{justCreated.plaintext}</code>
          </KeyValue>
        </Property>
        <PropertyLabel>&nbsp;</PropertyLabel>
        <Property>
          <Row className="button">
            <button type="button" className="colored" onClick={onCopy}>
              Copy&nbsp;to&nbsp;clipboard
            </button>
          </Row>
          <Row className="button">
            <button type="button" onClick={onSavedConfirm}>
              I&rsquo;ve&nbsp;saved&nbsp;it
            </button>
          </Row>
        </Property>
      </Properties>
    );
  }

  // ── Create form (key_id unset, no justCreated yet) ───────────────────
  if (isNew) {
    return (
      <Properties className="ApiKeyProperties">
        <PropertyLabel>New&nbsp;API&nbsp;Key</PropertyLabel>
        <Property>
          <KeyValue name="Name">
            <input
              type="text"
              placeholder="e.g. claoie-suggester"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={creating}
              maxLength={255}
            />
          </KeyValue>
          <KeyValue name="Scope">
            <select value={scope} onChange={(e) => setScope(e.target.value)} disabled={creating}>
              {SCOPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </KeyValue>
          {error && (
            <Row>
              <span className="apiKeyError">{error}</span>
            </Row>
          )}
        </Property>
        <PropertyLabel>&nbsp;</PropertyLabel>
        <Property>
          <Row className="button">
            <button
              type="button"
              className="colored"
              onClick={onCreate}
              disabled={creating || !name.trim()}
            >
              {creating ? "Creating…" : "Create Key"}
            </button>
          </Row>
          <Row className="button">
            <button type="button" onClick={goBack}>
              Cancel
            </button>
          </Row>
        </Property>
      </Properties>
    );
  }

  // ── Detail view loading state ────────────────────────────────────────
  if (loading && !apiKey) {
    return (
      <Properties className="ApiKeyProperties">
        <PropertyLabel>API&nbsp;Key</PropertyLabel>
        <Property>
          <Row>
            <span className="propertyName disabled">Loading&hellip;</span>
          </Row>
        </Property>
      </Properties>
    );
  }

  // ── Detail view error / not-found ────────────────────────────────────
  if (error || !apiKey) {
    return (
      <Properties className="ApiKeyProperties">
        <PropertyLabel>API&nbsp;Key</PropertyLabel>
        <Property>
          <Row>
            <span className="propertyName disabled">{error ?? "Not found"}</span>
          </Row>
        </Property>
        <PropertyLabel>&nbsp;</PropertyLabel>
        <Property>
          <Row className="button">
            <button type="button" onClick={goBack}>
              Back
            </button>
          </Row>
        </Property>
      </Properties>
    );
  }

  // ── Detail view ──────────────────────────────────────────────────────
  return (
    <Properties className="ApiKeyProperties">
      <PropertyLabel>API&nbsp;Key&nbsp;Details</PropertyLabel>
      <Property>
        <KeyValue name="Name">
          <span>{apiKey.name}</span>
        </KeyValue>
        <KeyValue name="Prefix">
          <code className="apiKeyPrefix">{apiKey.key_prefix}…</code>
        </KeyValue>
        <KeyValue name="Scopes">
          <span>{apiKey.scopes.join(", ")}</span>
        </KeyValue>
        <KeyValue name="Created">
          <span>{formatDate(apiKey.created_at)}</span>
        </KeyValue>
        <KeyValue name="Last&nbsp;Used">
          <span>{formatDate(apiKey.last_used_at)}</span>
        </KeyValue>
        {apiKey.expires_at && (
          <KeyValue name="Expires">
            <span>{formatDate(apiKey.expires_at)}</span>
          </KeyValue>
        )}
      </Property>
      <PropertyLabel>&nbsp;</PropertyLabel>
      <Property>
        <Row className="button">
          <DeleteButton onClick={onRevoke}>Revoke</DeleteButton>
        </Row>
        <Row className="button">
          <button type="button" onClick={goBack}>
            Back
          </button>
        </Row>
      </Property>
    </Properties>
  );
};
