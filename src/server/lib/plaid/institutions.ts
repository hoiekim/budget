import { CountryCode } from "plaid";
import { MaskedUser, logger } from "server";
import { JSONInstitution, Queue } from "common";
import { getClient } from "./util";

/**
 * Plaid addresses institutions one id at a time, so resolving a set costs one
 * round trip each. Plaid meters those against a single app-level credential
 * shared by every user, so the gate is process-wide rather than per request —
 * bounding a request in isolation would still let concurrent requests stack.
 */
const institutionQueue = new Queue({ maxInflight: 4 });

export const getInstitution = async (
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
    logger.error("Failed to get institution data", { institutionId: id }, error);
  }
};

/**
 * Resolve a set of institution ids through the shared concurrency gate.
 * Ids Plaid cannot resolve are absent from the result rather than failing the
 * batch — the caller renders whatever resolved.
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
