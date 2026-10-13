import {
  Route,
  requireBodyObject,
  requireStringField,
  validationError,
  previewPlanStatement,
  importPlanStatement,
  DECISIONS,
} from "server";
import type {
  Decision,
  PlanFundMappingRequest,
  PlanStatementImportResult,
  PlanStatementPreview,
  PlanStatementRequest,
  ServerRequest,
} from "server";

type ParsedRequest = { ok: true; request: PlanStatementRequest } | { ok: false; message: string };

const parseRequest = (req: ServerRequest): ParsedRequest => {
  const bodyResult = requireBodyObject(req);
  if (!bodyResult.success) return { ok: false, message: bodyResult.error! };
  const body = bodyResult.data as Record<string, unknown>;

  const accountResult = requireStringField(body, "account_id");
  if (!accountResult.success) return { ok: false, message: accountResult.error! };
  const csvResult = requireStringField(body, "csv");
  if (!csvResult.success) return { ok: false, message: csvResult.error! };

  const mappings: PlanFundMappingRequest[] = [];
  if (body.mappings !== undefined) {
    if (!Array.isArray(body.mappings)) return { ok: false, message: "mappings must be an array" };
    for (const m of body.mappings as unknown[]) {
      const { investment, security_id, restated } = (m ?? {}) as Record<string, unknown>;
      if (typeof investment !== "string" || !investment) {
        return { ok: false, message: "each mapping needs an investment" };
      }
      if (typeof security_id !== "string" || !security_id) {
        return { ok: false, message: "each mapping needs a security_id" };
      }
      if (typeof restated !== "boolean") return { ok: false, message: "mapping restated must be a boolean" };
      mappings.push({ investment, security_id, restated });
    }
  }

  const decisions: Record<string, Decision> = {};
  if (body.decisions !== undefined) {
    if (typeof body.decisions !== "object" || body.decisions === null || Array.isArray(body.decisions)) {
      return { ok: false, message: "decisions must be an object" };
    }
    for (const [id, decision] of Object.entries(body.decisions)) {
      if (!DECISIONS.includes(decision as Decision)) {
        return { ok: false, message: `unknown decision for ${id}` };
      }
      decisions[id] = decision as Decision;
    }
  }

  const replacePositions: string[] = [];
  if (body.replacePositions !== undefined) {
    if (!Array.isArray(body.replacePositions) || body.replacePositions.some((f) => typeof f !== "string")) {
      return { ok: false, message: "replacePositions must be an array of fund names" };
    }
    replacePositions.push(...(body.replacePositions as string[]));
  }

  return {
    ok: true,
    request: { account_id: accountResult.data!, csv: csvResult.data!, mappings, decisions, replacePositions },
  };
};

/**
 * POST /plan-statement/preview
 * Body: { account_id, csv, mappings?: [{ investment, security_id, restated }],
 *         decisions?: { [row id]: decision }, replacePositions?: [investment] }
 * Reads a plan statement against the account without writing anything.
 */
export const postPlanStatementPreviewRoute = new Route<PlanStatementPreview>(
  "POST",
  "/plan-statement/preview",
  async (req) => {
    const { user } = req.session;
    if (!user) return { status: "failed", message: "Request user is not authenticated." };
    const parsed = parseRequest(req);
    if (!parsed.ok) return validationError(parsed.message);
    const result = await previewPlanStatement(user, parsed.request);
    if (!result.ok) return { status: "failed", message: result.message };
    return { status: "success", body: result.preview };
  },
);

/**
 * POST /plan-statement/import
 * Same body as the preview. Writes the rows the preview lists as new, and
 * saves the fund mappings so the next statement doesn't ask again.
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
