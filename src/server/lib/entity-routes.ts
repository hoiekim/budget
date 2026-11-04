// One route shape per budget / category / section operation, parameterized
// by the repo function and the fields that differ per entity.
//
// The three entities share an auth guard, an id validated as a UUID, and the
// same failure answers; what differs is the repo function, the id field, and
// — for updates — the `FieldSpec[]` and any rule that is genuinely
// per-entity. That last part is the point of `extraChecks`: a rule that holds
// for one entity only stays an extra instead of a shared branch, so the
// shared skeleton never grows a per-entity `if`.
//
// The auth guard is deliberately NOT a parameter: it is the same check every
// route makes, and parameterizing it would let a call site forget it.
import { logger } from "./logger";
import type { MaskedUser } from "./postgres/models/user";
import { Route } from "./route";
import type { FieldSpec } from "./validation";
import {
  requireBodyObject,
  requireQueryString,
  requireStringField,
  validateFields,
  validationError,
} from "./validation";

// Fresh object per call, as the handlers returned a fresh literal each time.
// The return annotation keeps `status` the literal `"failed"` — without it
// the widened `string` is not an `ApiResponse` status.
const unauthenticated = (): { status: "failed"; message: string } => ({
  status: "failed",
  message: "Request user is not authenticated.",
});

/**
 * `DELETE /<entity>?id=` — auth, an `id` query param validated as a UUID,
 * the repo delete, `{ status: "success" }`. The repo's boolean return is
 * ignored: a delete that matches no row still answers success.
 */
export const makeDeleteEntityRoute = (
  path: string,
  deleteFn: (user: MaskedUser, id: string) => Promise<boolean>,
): Route<undefined> =>
  new Route("DELETE", path, async (req) => {
    const { user } = req.session;
    if (!user) return unauthenticated();

    const idResult = requireQueryString(req, "id");
    if (!idResult.success) return validationError(idResult.error!);
    // `id` becomes a UUID-column predicate below: reject a malformed
    // value here (400-style failed answer, no alarm) instead of
    // letting Postgres raise 22P02 inside Route.execute.
    const idCheck = validateFields(req.query, [{ path: "id", type: "uuid", required: true }]);
    if (!idCheck.success) return validationError(idCheck.error!);

    await deleteFn(user, idResult.data!);

    return { status: "success" };
  });

/**
 * `GET /new-<entity>[?parent=]` — auth, an optional `parent` query param
 * validated as a UUID when present, the repo create, and the created row
 * under `bodyKey`. A null create answers `failureMessage`; the repo returns
 * null for a foreign parent and for a missing one, so the route cannot tell
 * them apart. The parent-ownership check itself lives in the repository,
 * not here.
 */
export const makeGetNewEntityRoute = <T, K extends string, D extends Record<string, unknown>>(
  path: string,
  createFn: (user: MaskedUser, data: D) => Promise<T | null>,
  options: {
    parentField?: keyof D & string;
    bodyKey: K;
    failureMessage: string;
  },
): Route<{ [P in K]: T }> =>
  new Route<{ [P in K]: T }>("GET", path, async (req) => {
    const { user } = req.session;
    if (!user) return unauthenticated();

    let data = {} as D;
    if (options.parentField) {
      const parentResult = requireQueryString(req, "parent");
      if (!parentResult.success) return validationError(parentResult.error!);
      const parentShape = validateFields({ parent: parentResult.data }, [
        { path: "parent", type: "uuid" },
      ]);
      if (!parentShape.success) return validationError(parentShape.error!);
      data = { [options.parentField]: parentResult.data! } as D;
    }

    const response = await createFn(user, data);
    if (!response) {
      return { status: "failed", message: options.failureMessage };
    }
    return { status: "success", body: { [options.bodyKey]: response } as { [P in K]: T } };
  });

/** A per-entity rule the shared skeleton cannot express. It runs after field
 *  validation and before the repo call, and answers with a failure response
 *  or null to continue to the update. */
export type ExtraCheck = (data: Record<string, unknown>) => {
  status: "failed";
  message: string;
} | null;

/**
 * `POST /<entity>` — auth, a body object, the id field as a string, the
 * `FieldSpec[]` validation, the per-entity extra checks, then the repo
 * update. A repo throw is logged with the id and rethrown for the route's
 * alarm path.
 */
export const makeUpdateEntityRoute = <D extends Record<string, unknown>>(
  path: string,
  updateFn: (user: MaskedUser, id: string, data: D) => Promise<boolean>,
  options: {
    idField: string;
    fieldSpec: FieldSpec[];
    /** "budget" — the noun in the `Failed to update <entity>` log line. */
    entityLabel: string;
    /** "budgetId" — the logger context key for the id. */
    idLogKey: string;
    extraChecks?: ExtraCheck;
  },
): Route<undefined> =>
  new Route("POST", path, async (req) => {
    const { user } = req.session;
    if (!user) return unauthenticated();

    const bodyResult = requireBodyObject(req);
    if (!bodyResult.success) return validationError(bodyResult.error!);

    const body = bodyResult.data as Record<string, unknown>;
    const idResult = requireStringField(body, options.idField);
    if (!idResult.success) return validationError(idResult.error!);

    const fieldsResult = validateFields(body, options.fieldSpec);
    if (!fieldsResult.success) return validationError(fieldsResult.error!);

    const { [options.idField]: rawId, ...data } = body;

    const extra = options.extraChecks?.(data);
    if (extra) return extra;

    try {
      await updateFn(user, rawId as string, data as D);
      return { status: "success" };
    } catch (error: unknown) {
      logger.error(`Failed to update ${options.entityLabel}`, { [options.idLogKey]: rawId }, error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  });
