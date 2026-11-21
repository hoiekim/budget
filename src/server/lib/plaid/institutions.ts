import { CountryCode } from "plaid";
import { MaskedUser, logger } from "server";
import { JSONInstitution, Queue } from "common";
import { getClient } from "./util";

// Process-wide rather than per request: Plaid meters these calls against one
// app-level credential shared by every user of the deployment.
const institutionQueue = new Queue({ maxInflight: 4 });

/**
 * Plaid ids come from Link's own catalog, so an id it rejects is not expected
 * to start resolving soon; the one that plausibly could, a freshly connected
 * item's, is forgotten when the item is created.
 */
export const UNRESOLVABLE_INSTITUTION_TTL = 1000 * 60 * 60;
const MAX_UNRESOLVABLE_INSTITUTIONS = 10_000;

// Same scope as the queue: the round trips it saves are metered per deployment.
const unresolvableUntil = new Map<string, number>();

/** Plaid's answer for an institution_id outside its catalog. */
const isUnknownInstitutionError = (error: unknown): boolean =>
  (error as { response?: { data?: { error_code?: string } } })?.response?.data?.error_code ===
  "INVALID_INSTITUTION";

const rememberUnresolvable = (id: string) => {
  unresolvableUntil.delete(id);
  if (unresolvableUntil.size >= MAX_UNRESOLVABLE_INSTITUTIONS) {
    // Insertion order with one TTL: the first key is the soonest to expire.
    const soonest = unresolvableUntil.keys().next().value;
    if (soonest !== undefined) unresolvableUntil.delete(soonest);
  }
  unresolvableUntil.set(id, Date.now() + UNRESOLVABLE_INSTITUTION_TTL);
};

/**
 * True while Plaid's last answer for `id` was that no such institution exists.
 * Transient failures are never recorded, so they are asked again next time.
 */
export const isUnresolvableInstitution = (id: string): boolean => {
  const expiresAt = unresolvableUntil.get(id);
  if (expiresAt === undefined) return false;
  if (Date.now() < expiresAt) return true;
  unresolvableUntil.delete(id);
  return false;
};

export const forgetUnresolvableInstitution = (id: string) => {
  unresolvableUntil.delete(id);
};

const getInstitution = async (
  user: MaskedUser,
  id: string,
): Promise<JSONInstitution | undefined> => {
  const client = getClient(user);

  try {
    const response = await client.institutionsGetById({
      institution_id: id,
      country_codes: [CountryCode.Us],
    });

    const { institution } = response.data;

    const {
      institution_id,
      name,
      products,
      country_codes,
      url,
      primary_color,
      logo,
      routing_numbers,
      oauth,
      status,
    } = institution;

    return {
      institution_id,
      name,
      products,
      country_codes,
      url,
      primary_color,
      logo,
      routing_numbers,
      oauth,
      status,
    };
  } catch (error) {
    if (isUnknownInstitutionError(error)) rememberUnresolvable(id);
    logger.error("Failed to get institution data", { institutionId: id }, error);
  }
};

/**
 * Resolve a set of institution ids through the shared concurrency gate. Ids
 * Plaid cannot resolve are absent from the result rather than failing the batch.
 */
export const getInstitutionsByIds = async (
  user: MaskedUser,
  ids: string[],
): Promise<JSONInstitution[]> => {
  const settled = await Promise.all(
    ids.map((id) => institutionQueue.add(() => getInstitution(user, id))),
  );
  return settled.filter((institution): institution is JSONInstitution => !!institution);
};
