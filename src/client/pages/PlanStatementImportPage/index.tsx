import { ChangeEventHandler, Fragment, useRef, useState } from "react";
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
  PositionGap,
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

const formatUnits = (n: number) => Number(n.toFixed(4)).toString();

/**
 * The positions someone entered that the statement's transactions don't
 * explain, and what happens to them by default.
 */
const describeGaps = (gaps: PositionGap[], replacing: boolean) => {
  const shown = gaps
    .slice(0, 3)
    .map((g) => `${formatUnits(g.stored)} units on ${g.date} (${formatUnits(g.explained)} expected from earlier rows)`)
    .join("; ");
  const more = gaps.length > 3 ? ` and ${gaps.length - 3} more` : "";
  const outcome = replacing
    ? "They'll be removed, and the holding will follow the transactions alone."
    : "They're kept, and later transactions apply on top of them.";
  return `This holding has entered positions that earlier transactions and entries don't explain: ${shown}${more}. ${outcome}`;
};

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
  const [replacePositions, setReplacePositions] = useState<string[]>([]);
  const [preview, setPreview] = useState<PlanStatementPreview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  // Previews can overlap while closes load; only the latest one may land.
  const previewSeq = useRef(0);
  // The form as of the latest edit. Handlers that await (a ticker lookup) read
  // it afterwards instead of the values they started with, so an edit made in
  // the meantime isn't written back over.
  const form = useRef({
    csv: null as string | null,
    edits: {} as Record<string, FundEdit>,
    decisions: {} as Record<string, Decision>,
    replacePositions: [] as string[],
  });

  const changeEdits = (change: (current: Record<string, FundEdit>) => Record<string, FundEdit>) => {
    form.current.edits = change(form.current.edits);
    setEdits(form.current.edits);
  };

  const updateEdit = (investment: string, patch: Partial<FundEdit>) =>
    changeEdits((current) => ({
      ...current,
      [investment]: { ...(current[investment] ?? { ticker: "", security_id: null, restated: false }), ...patch },
    }));

  const requestBody = () => {
    const { csv, edits, decisions, replacePositions } = form.current;
    return {
      account_id: accountId,
      csv,
      mappings: Object.entries(edits)
        .filter(([, e]) => e.security_id)
        .map(([investment, e]) => ({ investment, security_id: e.security_id, restated: e.restated })),
      decisions,
      replacePositions,
    };
  };

  const runPreview = async () => {
    if (!form.current.csv) return;
    const seq = ++previewSeq.current;
    setBusy(true);
    const r = await call.post<PlanStatementPreview>("/api/plan-statement/preview", requestBody());
    if (seq !== previewSeq.current) return;
    setBusy(false);
    if (r.status !== "success" || !r.body) {
      setPreview(null);
      setError(r.message ?? "Failed to read the statement");
      return;
    }
    setError("");
    setPreview(r.body);
    // Funds the account already maps come back with their mapping; seed the
    // ones not yet edited so their ticker shows and later previews send them.
    const funds = r.body.funds;
    changeEdits((current) => {
      const seeded = { ...current };
      for (const fund of funds) {
        if (seeded[fund.investment] || !fund.mapping) continue;
        seeded[fund.investment] = {
          ticker: fund.mapping.ticker_symbol ?? "",
          security_id: fund.mapping.security_id,
          restated: fund.mapping.restated,
        };
      }
      return seeded;
    });
  };

  const onChangeFile: ChangeEventHandler<HTMLInputElement> = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    form.current = { ...form.current, csv: text, decisions: {}, replacePositions: [] };
    setFileName(file.name);
    setCsv(text);
    setResult("");
    setDecisions({});
    setReplacePositions([]);
    await runPreview();
  };

  const onBlurTicker = (investment: string) => async () => {
    const before = form.current.edits[investment];
    const ticker = before?.ticker.trim().toUpperCase() ?? "";
    if (!ticker || !form.current.csv) return;
    const r = await call.post<ValidateTickerResponse>("/api/validate-ticker", { ticker_symbol: ticker });
    // The user may have typed another ticker while this one was checked.
    if ((form.current.edits[investment]?.ticker.trim().toUpperCase() ?? "") !== ticker) return;
    if (r.status === "success" && r.body?.valid && r.body.security) {
      if (r.body.security.security_id === form.current.edits[investment]?.security_id) return;
      updateEdit(investment, { ticker, security_id: r.body.security.security_id, error: undefined });
      await runPreview();
    } else {
      updateEdit(investment, { error: r.body?.message ?? r.message ?? "Invalid ticker" });
    }
  };

  const onToggleRestated = (investment: string) => async () => {
    updateEdit(investment, { restated: !form.current.edits[investment]?.restated });
    if (form.current.edits[investment]?.security_id) await runPreview();
  };

  const onToggleReplacePositions = (investment: string) => async () => {
    const current = form.current.replacePositions;
    form.current.replacePositions = current.includes(investment)
      ? current.filter((f) => f !== investment)
      : [...current, investment];
    setReplacePositions(form.current.replacePositions);
    await runPreview();
  };

  const onChangeDecision = (id: string): ChangeEventHandler<HTMLSelectElement> => async (e) => {
    const next = { ...form.current.decisions };
    if (e.target.value) next[id] = e.target.value as Decision;
    else delete next[id];
    form.current.decisions = next;
    setDecisions(next);
    await runPreview();
  };

  const onClickImport = async () => {
    if (!form.current.csv || !preview) return;
    setBusy(true);
    const r = await call.post<PlanStatementImportResult>("/api/plan-statement/import", requestBody());
    setBusy(false);
    if (r.status !== "success" || !r.body) {
      setError(r.message ?? "Import failed");
      return;
    }
    const { written } = r.body;
    setResult(`Imported ${written} transaction${written === 1 ? "" : "s"}.`);
    sync();
    await runPreview();
  };

  const newRows = preview?.rows.filter((r) => r.status === "new") ?? [];
  const decisionRows = preview?.rows.filter((r) => r.needsDecision && r.status !== "imported") ?? [];
  const importedCount = preview?.rows.filter((r) => r.status === "imported").length ?? 0;
  const skippedCount = preview?.rows.filter((r) => r.status === "skip").length ?? 0;
  // Replacing entered positions is worth applying even when nothing is new.
  const replacing = !!preview?.funds.some((f) => f.replacePositions && f.positionGaps?.length);
  const canImport = !!preview && !busy && !preview.blockers.length && (newRows.length > 0 || replacing);

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
          {preview.funds.map((fund, i, { length }) => {
            const edit = edits[fund.investment];
            return (
              <Fragment key={fund.investment}>
                <PropertyLabel>{length > 1 ? `Fund ${i + 1}` : "Fund"}</PropertyLabel>
                <Property>
                  <KeyValue name="Name">
                    <span>{fund.investment}</span>
                  </KeyValue>
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
                  {fund.positionGaps && fund.positionGaps.length > 0 && (
                    <>
                      <Row className="formError">
                        {describeGaps(fund.positionGaps, replacePositions.includes(fund.investment))}
                      </Row>
                      <KeyValue name="Replace&nbsp;with&nbsp;statement&#8209;derived&nbsp;positions">
                        <ToggleInput
                          checked={replacePositions.includes(fund.investment)}
                          onChange={onToggleReplacePositions(fund.investment)}
                        />
                      </KeyValue>
                    </>
                  )}
                  {fund.restatement?.retryable && csv && (
                    <ButtonRow disabled={busy} onClick={runPreview}>
                      Retry
                    </ButtonRow>
                  )}
                </Property>
              </Fragment>
            );
          })}

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
                        {(row.allowedDecisions ?? ["skip"]).map((value) => (
                          <option key={value} value={value}>
                            {DECISION_LABELS[value]}
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
              {newRows.length || !replacing ? (
                <>
                  Import&nbsp;{newRows.length}&nbsp;row{newRows.length === 1 ? "" : "s"}
                </>
              ) : (
                <>Replace&nbsp;positions</>
              )}
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
