import { ChangeEventHandler, Fragment, useMemo, useRef, useState } from "react";
import {
  Decision,
  EnteredPosition,
  FundMapping,
  HeldMovement,
  ImportKind,
  PlannedRow,
  PlanStatementImportResult,
  PositionGap,
  RestatementCloses,
  StatementRow,
  closesRange,
  inferencePeriod,
  getYearMonthString,
  numberToCommaString,
  parsePlanStatement,
  previewPlanStatement,
} from "common";
import {
  call,
  PATH,
  SecurityDictionary,
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
import type { ValidateTickerResponse } from "server";
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

/** Closes are kept per fund, ticker and range, so a new ticker or another statement asks again. */
const closesKey = (investment: string, ticker: string, from: string, to: string) =>
  [investment, ticker, from, to].join("\0");

/** The mapped security's ticker, or what the user typed before it resolved. */
const tickerOf = (edit: FundEdit, securities: SecurityDictionary) =>
  (edit.security_id && securities.get(edit.security_id)?.ticker_symbol) || edit.ticker.trim().toUpperCase();

const PlanStatementImporter = ({ accountId }: { accountId: string }) => {
  const { data } = useAppContext();
  const { sync } = useSync();
  const account = data.accounts.get(accountId);

  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [edits, setEdits] = useState<Record<string, FundEdit>>({});
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [replacePositions, setReplacePositions] = useState<string[]>([]);
  const [closes, setCloses] = useState<Record<string, RestatementCloses>>({});
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());
  const [loadingCloses, setLoadingCloses] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  /** Rows the last import attempt found deleted from the account, now planned around. */
  const [refusedRows, setRefusedRows] = useState(0);
  // The edits as of the latest change. Handlers that await (a ticker lookup)
  // read it afterwards instead of the values they started with, so an edit
  // made in the meantime isn't written back over.
  const latestEdits = useRef<Record<string, FundEdit>>({});
  const closesRef = useRef<Record<string, RestatementCloses>>({});
  const loadingRef = useRef(new Set<string>());

  const changeEdits = (change: (current: Record<string, FundEdit>) => Record<string, FundEdit>) => {
    latestEdits.current = change(latestEdits.current);
    setEdits(latestEdits.current);
  };

  const updateEdit = (investment: string, patch: Partial<FundEdit>) =>
    changeEdits((current) => ({
      ...current,
      [investment]: { ...(current[investment] ?? { ticker: "", security_id: null, restated: false }), ...patch },
    }));

  /** The account's restated funds the statement has no rows for, whose holdings are still owed its period's payouts. */
  const otherRestated = (text: string): Record<string, FundEdit> => {
    const funds = new Set(parsePlanStatement(text).rows.map((r) => r.investment));
    const others: Record<string, FundEdit> = {};
    for (const m of account?.plan_fund_mappings ?? []) {
      if (!m.restated || funds.has(m.investment)) continue;
      const ticker = data.securities.get(m.security_id)?.ticker_symbol ?? "";
      others[m.investment] = { ticker, security_id: m.security_id, restated: true };
    }
    return others;
  };

  const accountDates = () => {
    const dates: string[] = [];
    data.investmentTransactions.forEach((t) => {
      if (t.account_id === accountId) dates.push(t.date.slice(0, 10));
    });
    return dates;
  };

  /** The closes a restated fund needs: the statement's rows, and the period whose payouts it infers. */
  const closesRequest = (rows: StatementRow[], investment: string, edit: FundEdit) => {
    const ticker = tickerOf(edit, data.securities);
    if (!edit.restated || !edit.security_id || !ticker || !rows.length) return null;
    const { after, through } = inferencePeriod(rows, accountDates());
    const { from, to } = closesRange([rows[0].date, through, ...(after ? [after] : [])]);
    return { key: closesKey(investment, ticker, from, to), ticker, from, to };
  };

  /** Asks for the closes of each restated fund that doesn't have them yet; `retry` asks again after a failure. */
  const requestCloses = async (text: string, fundEdits: Record<string, FundEdit>, retry = false) => {
    const rows = parsePlanStatement(text).rows;
    const wanted = Object.entries({ ...otherRestated(text), ...fundEdits }).flatMap(([investment, edit]) => {
      const request = closesRequest(rows, investment, edit);
      if (!request) return [];
      const known = closesRef.current[request.key];
      if (loadingRef.current.has(request.key) || (known && !(retry && !("bars" in known)))) return [];
      return [request];
    });
    if (!wanted.length) return;
    for (const { key } of wanted) loadingRef.current.add(key);
    setLoadingCloses(Array.from(loadingRef.current));
    await Promise.all(
      wanted.map(async ({ key, ticker, from, to }) => {
        const params = new URLSearchParams({ ticker, from, to });
        const r = await call.get<RestatementCloses>(`/api/daily-closes?${params}`);
        const answer: RestatementCloses =
          r.status === "success" && r.body ? r.body : { message: r.message ?? `Couldn't load ${ticker} prices` };
        closesRef.current = { ...closesRef.current, [key]: answer };
        loadingRef.current.delete(key);
        setCloses(closesRef.current);
        setLoadingCloses(Array.from(loadingRef.current));
      }),
    );
  };

  const preview = useMemo(() => {
    if (!csv) return null;
    const rows = parsePlanStatement(csv).rows;
    const mappings = new Map<string, FundMapping>();
    const fundCloses = new Map<string, RestatementCloses>();
    for (const [investment, edit] of Object.entries({ ...otherRestated(csv), ...edits })) {
      if (!edit.security_id) continue;
      const ticker = tickerOf(edit, data.securities);
      mappings.set(investment, { security_id: edit.security_id, restated: edit.restated, ticker_symbol: ticker || null });
      const request = closesRequest(rows, investment, edit);
      if (request) {
        fundCloses.set(investment, closes[request.key] ?? { message: `Prices for ${ticker} are loading…`, retryable: true });
      }
    }
    const existingIds = new Set<string>();
    data.investmentTransactions.forEach((t) => {
      if (t.account_id === accountId) existingIds.add(t.investment_transaction_id);
    });
    const holding = (security_id: string) => {
      const movements: HeldMovement[] = [];
      data.investmentTransactions.forEach((t) => {
        if (t.account_id === accountId && t.security_id === security_id) movements.push(t);
      });
      const entered: EnteredPosition[] = [];
      data.holdingSnapshots.forEach(({ snapshot, holding }) => {
        if (holding.account_id !== accountId || holding.security_id !== security_id) return;
        entered.push({
          snapshot_id: snapshot.snapshot_id,
          date: snapshot.date.slice(0, 10),
          quantity: holding.quantity,
          cost_basis: holding.cost_basis ?? null,
          institution_price: holding.institution_price ?? null,
        });
      });
      return { movements, entered };
    };
    return previewPlanStatement({
      account_id: accountId,
      iso_currency_code: account?.balances.iso_currency_code || "USD",
      csv,
      mappings,
      decisions,
      closes: fundCloses,
      existingIds,
      deletedIds,
      accountDates: accountDates(),
      replace: new Set(replacePositions),
      holding,
      throughMonth: getYearMonthString(new Date()),
    });
  }, [csv, edits, decisions, replacePositions, closes, deletedIds, data.investmentTransactions, data.holdingSnapshots, data.securities, accountId, account]);

  const plan = preview && "error" in preview ? null : preview;
  const planError = preview && "error" in preview ? preview.error : "";

  const onChangeFile: ChangeEventHandler<HTMLInputElement> = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const funds = new Set(parsePlanStatement(text).rows.map((r) => r.investment));
    // Funds this account already maps open with their mapping.
    const seeded: Record<string, FundEdit> = {};
    for (const m of account?.plan_fund_mappings ?? []) {
      if (!funds.has(m.investment)) continue;
      const ticker = data.securities.get(m.security_id)?.ticker_symbol ?? "";
      seeded[m.investment] = { ticker, security_id: m.security_id, restated: m.restated };
    }
    changeEdits(() => seeded);
    setFileName(file.name);
    setCsv(text);
    setResult("");
    setRefusedRows(0);
    setError("");
    setDecisions({});
    setReplacePositions([]);
    await requestCloses(text, seeded);
  };

  const onBlurTicker = (investment: string) => async () => {
    const before = latestEdits.current[investment];
    const ticker = before?.ticker.trim().toUpperCase() ?? "";
    if (!ticker || !csv) return;
    const r = await call.post<ValidateTickerResponse>("/api/validate-ticker", { ticker_symbol: ticker });
    // The user may have typed another ticker while this one was checked.
    if ((latestEdits.current[investment]?.ticker.trim().toUpperCase() ?? "") !== ticker) return;
    if (r.status === "success" && r.body?.valid && r.body.security) {
      if (r.body.security.security_id === latestEdits.current[investment]?.security_id) return;
      updateEdit(investment, { ticker, security_id: r.body.security.security_id, error: undefined });
      await requestCloses(csv, latestEdits.current);
    } else {
      updateEdit(investment, { error: r.body?.message ?? r.message ?? "Invalid ticker" });
    }
  };

  const onToggleRestated = (investment: string) => async () => {
    updateEdit(investment, { restated: !latestEdits.current[investment]?.restated });
    if (csv) await requestCloses(csv, latestEdits.current);
  };

  const onClickRetry = async () => {
    if (csv) await requestCloses(csv, latestEdits.current, true);
  };

  const onToggleReplacePositions = (investment: string) => () =>
    setReplacePositions((current) =>
      current.includes(investment) ? current.filter((f) => f !== investment) : [...current, investment],
    );

  const onChangeDecision = (id: string): ChangeEventHandler<HTMLSelectElement> => (e) => {
    const value = e.target.value as Decision | "";
    setDecisions((current) => {
      const next = { ...current };
      if (value) next[id] = value;
      else delete next[id];
      return next;
    });
  };

  const onClickImport = async () => {
    if (!plan?.request) return;
    setBusy(true);
    const r = await call.post<PlanStatementImportResult>("/api/plan-statement/import", plan.request);
    setBusy(false);
    if (r.status !== "success" || !r.body) {
      setError(r.message ?? "Import failed");
      return;
    }
    const { written, alreadyImported, deleted } = r.body;
    setError("");
    if (deleted?.length) {
      // The page holds only live rows, so it planned these as new; it plans again around them.
      setDeletedIds((current) => new Set([...current, ...deleted]));
      setRefusedRows(new Set(deleted.map((id) => id.replace(/-cash$/, ""))).size);
      setResult("");
      return;
    }
    const skipped = alreadyImported
      ? ` ${alreadyImported} already in the account ${alreadyImported === 1 ? "was" : "were"} left as ${alreadyImported === 1 ? "it was" : "they were"}.`
      : "";
    setRefusedRows(0);
    setResult(`Imported ${written} transaction${written === 1 ? "" : "s"}.${skipped}`);
    setReplacePositions([]);
    sync();
  };

  const newRows = plan?.rows.filter((r) => r.status === "new") ?? [];
  const reinvestments = plan?.reinvestments ?? [];
  const writing = newRows.length + reinvestments.length;
  const decisionRows = plan?.rows.filter((r) => r.needsDecision && r.status !== "imported") ?? [];
  const importedCount = plan?.rows.filter((r) => r.status === "imported").length ?? 0;
  const skippedCount = plan?.rows.filter((r) => r.status === "skip").length ?? 0;
  // Replacing entered positions is worth applying even when nothing is new.
  const replacing = !!plan?.funds.some((f) => f.replacePositions && f.positionGaps?.length);
  const canImport = !!plan?.request && !busy && (writing > 0 || replacing);

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
        {busy && <Row className="fundNote">Importing…</Row>}
        {(error || planError) && <Row className="formError">{error || planError}</Row>}
        {plan?.parseErrors.map((e) => (
          <Row key={e} className="formError">
            {e}
          </Row>
        ))}
      </Property>

      {plan && (
        <>
          {plan.funds.map((fund, i, { length }) => {
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
                    <ToggleInput checked={!!edit?.restated} onChange={onToggleRestated(fund.investment)} />
                  </KeyValue>
                  {edit?.error && <Row className="formError">{edit.error}</Row>}
                  {fund.restatement && (
                    <Row className={fund.restatement.ok ? "fundNote" : "formError"}>
                      {fund.restatement.ok
                        ? `Tracks ${fund.mapping?.ticker_symbol} within ${((fund.restatement.spread ?? 0) * 100).toFixed(2)}%`
                        : fund.restatement.message}
                    </Row>
                  )}
                  {fund.positionGaps && fund.positionGaps.length > 0 && (
                    <>
                      <Row className="formError">
                        {describeGaps(fund.positionGaps, !!fund.replacePositions)}
                      </Row>
                      <KeyValue name="Replace&nbsp;with&nbsp;statement&#8209;derived&nbsp;positions">
                        <ToggleInput
                          checked={replacePositions.includes(fund.investment)}
                          onChange={onToggleReplacePositions(fund.investment)}
                        />
                      </KeyValue>
                    </>
                  )}
                  {fund.restatement?.retryable && (
                    <ButtonRow disabled={loadingCloses.length > 0} onClick={onClickRetry}>
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
            {reinvestments.length > 0 && (
              <KeyValue name="Inferred&nbsp;dividends">
                <span>{reinvestments.length}</span>
              </KeyValue>
            )}
            {plan.blockers.map((b) => (
              <Row key={b} className="formError">
                {b}
              </Row>
            ))}
            {plan.retryCloses && (
              <ButtonRow disabled={loadingCloses.length > 0} onClick={onClickRetry}>
                Retry
              </ButtonRow>
            )}
            {result && <Row className="fundNote">{result}</Row>}
            {refusedRows > 0 && (
              <Row className="fundNote">
                {refusedRows === 1 ? "1 row was" : `${refusedRows} rows were`} deleted from the account earlier and{" "}
                {refusedRows === 1 ? "stays" : "stay"} deleted, so the preview now leaves{" "}
                {refusedRows === 1 ? "it" : "them"} out.{" "}
                {writing ? "Check it and import again." : "Nothing else is left to import."}
              </Row>
            )}
            <ButtonRow disabled={!canImport} onClick={onClickImport}>
              {writing || !replacing ? (
                <>
                  Import&nbsp;{writing}&nbsp;row{writing === 1 ? "" : "s"}
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

          {reinvestments.length > 0 && (
            <>
              <PropertyLabel>Inferred&nbsp;dividends</PropertyLabel>
              <Property>
                <Row className="fundNote">
                  The trust keeps its payouts in its unit price, so each payout of the public fund is added as a
                  dividend reinvested at that day&apos;s close.
                </Row>
                {reinvestments.map((r) => (
                  <Row key={`${r.investment}-${r.ex_date}`} className="statementRow">
                    {r.ex_date} · {r.investment} · {formatAmount(r.amount)} · {formatUnits(r.quantity)} sh
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
