import { ChangeEventHandler, Fragment, useState } from "react";
import { numberToCommaString } from "common";
import {
  call,
  PATH,
  useAppContext,
  useSync,
  ButtonRow,
  KeyValue,
  Properties,
  Property,
  PropertyLabel,
  Row,
  ToggleInput,
} from "client";
import type {
  Decision,
  ImportKind,
  PlannedRow,
  PlanStatementImportResult,
  PlanStatementPreview,
  ValidateTickerResponse,
} from "server";
import "./index.css";

const DECISION_LABELS: Record<Decision, string> = {
  contribution: "Contribution",
  dividend: "Dividend reinvestment",
  fee: "Fee",
  withdrawal_out: "Withdrawal, money leaves",
  withdrawal_kept: "Withdrawal, kept as cash",
  rollover_in: "Rollover in",
  skip: "Skip",
};

interface FundEdit {
  ticker: string;
  security_id: string | null;
  restated: boolean;
  error?: string;
}

const formatAmount = (n: number) => `$ ${numberToCommaString(n)}`;

const describeRow = (row: PlannedRow) =>
  `${row.date} · ${row.investment} · ${row.label} · ${formatAmount(row.amount)} · ${row.shares} sh`;

const PlanStatementImporter = ({ accountId }: { accountId: string }) => {
  const { data } = useAppContext();
  const { sync } = useSync();
  const account = data.accounts.get(accountId);

  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [edits, setEdits] = useState<Record<string, FundEdit>>({});
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [preview, setPreview] = useState<PlanStatementPreview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");

  const requestBody = (
    nextCsv: string,
    nextEdits: Record<string, FundEdit>,
    nextDecisions: Record<string, Decision>,
  ) => ({
    account_id: accountId,
    csv: nextCsv,
    mappings: Object.entries(nextEdits)
      .filter(([, e]) => e.security_id)
      .map(([investment, e]) => ({ investment, security_id: e.security_id, restated: e.restated })),
    decisions: nextDecisions,
  });

  const runPreview = async (
    nextCsv: string,
    nextEdits: Record<string, FundEdit>,
    nextDecisions: Record<string, Decision>,
  ) => {
    setBusy(true);
    const r = await call.post<PlanStatementPreview>(
      "/api/plan-statement/preview",
      requestBody(nextCsv, nextEdits, nextDecisions),
    );
    setBusy(false);
    if (r.status !== "success" || !r.body) {
      setPreview(null);
      setError(r.message ?? "Failed to read the statement");
      return;
    }
    setError("");
    setPreview(r.body);
    // Funds the account already maps come back with their mapping; seed those
    // so their ticker shows and later previews keep sending them.
    const seeded = { ...nextEdits };
    for (const fund of r.body.funds) {
      if (seeded[fund.investment] || !fund.mapping) continue;
      seeded[fund.investment] = {
        ticker: fund.mapping.ticker_symbol ?? "",
        security_id: fund.mapping.security_id,
        restated: fund.mapping.restated,
      };
    }
    setEdits(seeded);
  };

  const onChangeFile: ChangeEventHandler<HTMLInputElement> = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setFileName(file.name);
    setCsv(text);
    setResult("");
    setDecisions({});
    await runPreview(text, edits, {});
  };

  const updateEdit = (investment: string, patch: Partial<FundEdit>) => {
    const current = edits[investment] ?? { ticker: "", security_id: null, restated: false };
    const next = { ...edits, [investment]: { ...current, ...patch } };
    setEdits(next);
    return next;
  };

  const onBlurTicker = (investment: string) => async () => {
    const edit = edits[investment];
    const ticker = edit?.ticker.trim().toUpperCase() ?? "";
    if (!ticker || !csv) return;
    const r = await call.post<ValidateTickerResponse>("/api/validate-ticker", { ticker_symbol: ticker });
    if (r.status === "success" && r.body?.valid && r.body.security) {
      if (r.body.security.security_id === edit?.security_id) return;
      const next = updateEdit(investment, {
        ticker,
        security_id: r.body.security.security_id,
        error: undefined,
      });
      await runPreview(csv, next, decisions);
    } else {
      updateEdit(investment, { error: r.body?.message ?? r.message ?? "Invalid ticker" });
    }
  };

  const onToggleRestated = (investment: string) => async () => {
    if (!csv) return;
    const next = updateEdit(investment, { restated: !edits[investment]?.restated });
    if (next[investment].security_id) await runPreview(csv, next, decisions);
  };

  const onChangeDecision = (id: string): ChangeEventHandler<HTMLSelectElement> => async (e) => {
    if (!csv) return;
    const next = { ...decisions };
    if (e.target.value) next[id] = e.target.value as Decision;
    else delete next[id];
    setDecisions(next);
    await runPreview(csv, edits, next);
  };

  const onClickImport = async () => {
    if (!csv || !preview) return;
    setBusy(true);
    const r = await call.post<PlanStatementImportResult>(
      "/api/plan-statement/import",
      requestBody(csv, edits, decisions),
    );
    setBusy(false);
    if (r.status !== "success" || !r.body) {
      setError(r.message ?? "Import failed");
      return;
    }
    const { written } = r.body;
    setResult(`Imported ${written} transaction${written === 1 ? "" : "s"}.`);
    sync();
    await runPreview(csv, edits, decisions);
  };

  const newRows = preview?.rows.filter((r) => r.status === "new") ?? [];
  const decisionRows = preview?.rows.filter((r) => r.needsDecision && r.status !== "imported") ?? [];
  const importedCount = preview?.rows.filter((r) => r.status === "imported").length ?? 0;
  const skippedCount = preview?.rows.filter((r) => r.status === "skip").length ?? 0;
  const canImport = !!preview && !busy && !preview.blockers.length && newRows.length > 0;

  return (
    <Properties className="PlanStatementImportPage">
      <PropertyLabel>Import&nbsp;Plan&nbsp;Statement</PropertyLabel>
      <Property>
        <KeyValue name="Account">
          <span>{account?.custom_name || account?.name || accountId}</span>
        </KeyValue>
        <KeyValue name="Statement">
          <label className="fileInput">
            <span>{fileName || "Choose CSV"}</span>
            <input type="file" accept=".csv,text/csv" onChange={onChangeFile} />
          </label>
        </KeyValue>
        {busy && <Row className="fundNote">Reading the statement…</Row>}
        {error && <Row className="formError">{error}</Row>}
        {preview?.parseErrors.map((e) => (
          <Row key={e} className="formError">
            {e}
          </Row>
        ))}
      </Property>

      {preview && (
        <>
          <PropertyLabel>Funds</PropertyLabel>
          <Property>
            {preview.funds.map((fund) => {
              const edit = edits[fund.investment];
              return (
                <Fragment key={fund.investment}>
                  <Row className="fundName">{fund.investment}</Row>
                  <KeyValue name="Ticker">
                    <input
                      type="text"
                      value={edit?.ticker ?? ""}
                      placeholder="Ticker"
                      onChange={(e) => updateEdit(fund.investment, { ticker: e.target.value })}
                      onBlur={onBlurTicker(fund.investment)}
                    />
                  </KeyValue>
                  <KeyValue name="Restated&nbsp;from&nbsp;a&nbsp;trust">
                    <ToggleInput
                      checked={!!edit?.restated}
                      onChange={onToggleRestated(fund.investment)}
                    />
                  </KeyValue>
                  {edit?.error && <Row className="formError">{edit.error}</Row>}
                  {fund.restatement && (
                    <Row className={fund.restatement.ok ? "fundNote" : "formError"}>
                      {fund.restatement.ok
                        ? `Tracks ${fund.mapping?.ticker_symbol} within ${(
                            (fund.restatement.spread ?? 0) * 100
                          ).toFixed(2)}%`
                        : fund.restatement.message}
                    </Row>
                  )}
                </Fragment>
              );
            })}
          </Property>

          {decisionRows.length > 0 && (
            <>
              <PropertyLabel>Needs&nbsp;a&nbsp;decision</PropertyLabel>
              <Property>
                {decisionRows.map((row) => (
                  <Fragment key={row.id}>
                    <Row className="statementRow">{describeRow(row)}</Row>
                    <KeyValue name="Treat&nbsp;as">
                      <select value={decisions[row.id] ?? ""} onChange={onChangeDecision(row.id)}>
                        <option value="">Choose</option>
                        {Object.entries(DECISION_LABELS).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </KeyValue>
                  </Fragment>
                ))}
              </Property>
            </>
          )}

          <PropertyLabel>Preview</PropertyLabel>
          <Property>
            <KeyValue name="New">
              <span>{newRows.length}</span>
            </KeyValue>
            <KeyValue name="Already&nbsp;imported">
              <span>{importedCount}</span>
            </KeyValue>
            <KeyValue name="Skipped">
              <span>{skippedCount}</span>
            </KeyValue>
            {preview.blockers.map((b) => (
              <Row key={b} className="formError">
                {b}
              </Row>
            ))}
            {result && <Row className="fundNote">{result}</Row>}
            <ButtonRow disabled={!canImport} onClick={onClickImport}>
              Import&nbsp;{newRows.length}&nbsp;row{newRows.length === 1 ? "" : "s"}
            </ButtonRow>
          </Property>

          {newRows.length > 0 && (
            <>
              <PropertyLabel>New&nbsp;rows</PropertyLabel>
              <Property>
                {newRows.map((row) => (
                  <Row key={row.id} className="statementRow">
                    {row.date} · {row.investment} · {DECISION_LABELS[row.kind as ImportKind]} ·{" "}
                    {formatAmount(Math.abs(row.amount))}
                  </Row>
                ))}
              </Property>
            </>
          )}
        </>
      )}
    </Properties>
  );
};

export const PlanStatementImportPage = () => {
  const { router } = useAppContext();
  const params = router.getActiveParams(PATH.PLAN_STATEMENT_IMPORT);
  const accountId = params.get("account_id") || "";

  return (
    <div className="PlanStatementImportPage">
      {accountId ? (
        <PlanStatementImporter accountId={accountId} />
      ) : (
        <Properties className="PlanStatementImportPage">
          <PropertyLabel>Import&nbsp;Plan&nbsp;Statement</PropertyLabel>
          <Property>
            <KeyValue name="Missing&nbsp;account&nbsp;context">
              <span></span>
            </KeyValue>
          </Property>
        </Properties>
      )}
    </div>
  );
};
