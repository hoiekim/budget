import {
  isCalendarDate,
  PlanFundMapping,
  PlannedTransaction,
  PlanStatementHolding,
  PlanStatementImportRequest,
  PlanStatementImportResult,
} from "common";
import { Route, requireBodyObject, requireStringField, validationError, importPlanStatement } from "server";
import type { ServerRequest } from "server";

type ParsedRequest = { ok: true; request: PlanStatementImportRequest } | { ok: false; message: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

const parseRequest = (req: ServerRequest): ParsedRequest => {
  const bodyResult = requireBodyObject(req);
  if (!bodyResult.success) return { ok: false, message: bodyResult.error! };
  const body = bodyResult.data as Record<string, unknown>;

  const accountResult = requireStringField(body, "account_id");
  if (!accountResult.success) return { ok: false, message: accountResult.error! };

  if (!Array.isArray(body.transactions)) return { ok: false, message: "transactions must be an array" };
  const transactions: PlannedTransaction[] = [];
  for (const planned of body.transactions as unknown[]) {
    if (!isObject(planned) || !isObject(planned.transaction)) {
      return { ok: false, message: "each transaction needs a transaction object" };
    }
    const t = planned.transaction;
    if (!isNonEmptyString(t.investment_transaction_id)) return { ok: false, message: "each transaction needs an id" };
    if (!isCalendarDate(t.date)) return { ok: false, message: "each transaction needs a YYYY-MM-DD date" };
    if (planned.restated_from !== undefined && !isObject(planned.restated_from)) {
      return { ok: false, message: "restated_from must be an object" };
    }
    transactions.push(planned as unknown as PlannedTransaction);
  }

  if (!Array.isArray(body.mappings)) return { ok: false, message: "mappings must be an array" };
  const mappings: PlanFundMapping[] = [];
  for (const m of body.mappings as unknown[]) {
    const { investment, security_id, restated } = isObject(m) ? m : {};
    if (!isNonEmptyString(investment)) return { ok: false, message: "each mapping needs an investment" };
    if (!isNonEmptyString(security_id)) return { ok: false, message: "each mapping needs a security_id" };
    if (typeof restated !== "boolean") return { ok: false, message: "mapping restated must be a boolean" };
    mappings.push({ investment, security_id, restated });
  }

  const replace = body.replace ?? [];
  if (!Array.isArray(replace) || !replace.every(isNonEmptyString)) {
    return { ok: false, message: "replace must be an array of security ids" };
  }

  if (!Array.isArray(body.holdings)) return { ok: false, message: "holdings must be an array" };
  const holdings: PlanStatementHolding[] = [];
  for (const h of body.holdings as unknown[]) {
    const { security_id, date, quantity, cost_basis, price } = isObject(h) ? h : {};
    if (!isNonEmptyString(security_id)) return { ok: false, message: "each holding needs a security_id" };
    if (!isCalendarDate(date)) return { ok: false, message: "each holding needs a YYYY-MM-DD date" };
    if (!isFiniteNumber(quantity) || !isFiniteNumber(price) || (cost_basis !== null && !isFiniteNumber(cost_basis))) {
      return { ok: false, message: "each holding needs a quantity, a price and a cost basis or null" };
    }
    holdings.push({ security_id, date, quantity, cost_basis, price });
  }

  return { ok: true, request: { account_id: accountResult.data!, transactions, mappings, replace, holdings } };
};

/**
 * POST /plan-statement/import
 * Body: { account_id, transactions: [{ transaction, restated_from?, reinvested_distribution? }],
 *         mappings: [{ investment, security_id, restated }], replace?: [security_id],
 *         holdings: [{ security_id, date, quantity, cost_basis, price }] }
 * Stores the rows the import page planned from a plan statement. Rows already
 * in the account are left as they are. When any planned row was deleted from
 * the account, nothing is stored and their ids come back as `deleted`, for the
 * page to plan again around them.
 */
export const postPlanStatementImportRoute = new Route<PlanStatementImportResult>(
  "POST",
  "/plan-statement/import",
  async (req) => {
    const { user } = req.session;
    if (!user) return { status: "failed", message: "Request user is not authenticated." };
    const parsed = parseRequest(req);
    if (!parsed.ok) return validationError(parsed.message);
    const result = await importPlanStatement(user, parsed.request);
    if (!result.ok) return { status: "failed", message: result.message };
    return { status: "success", body: result.result };
  },
);
