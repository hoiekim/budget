import { CountryCode } from "plaid";
import { MaskedUser, logger } from "server";
import { JSONInstitution, Queue } from "common";
import { PLAID_FOREGROUND_WAIT_MS, PlaidClientDeps, getClient, plaidQueue } from "./util";

// A sub-cap inside the shared Plaid gate, so one institutions batch cannot
// take every slot from the sync paths.
const institutionQueue = new Queue({ maxInflight: 4 });

const getInstitution = async (
  user: MaskedUser,
  id: string,
  getClientFn: typeof getClient,
): Promise<JSONInstitution | undefined> => {
  const client = getClientFn(user);

  try {
    const response = await plaidQueue.add(
      () =>
        client.institutionsGetById({
          institution_id: id,
          country_codes: [CountryCode.Us],
        }),
      { maxWaitMs: PLAID_FOREGROUND_WAIT_MS },
    );

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
 * Resolve a set of institution ids through the shared concurrency gate. Ids
 * Plaid cannot resolve are absent from the result rather than failing the batch.
 */
export const getInstitutionsByIds = async (
  user: MaskedUser,
  ids: string[],
  { getClient: getClientFn = getClient }: PlaidClientDeps = {},
): Promise<JSONInstitution[]> => {
  const settled = await Promise.all(
    ids.map((id) => institutionQueue.add(() => getInstitution(user, id, getClientFn))),
  );
  return settled.filter((institution): institution is JSONInstitution => !!institution);
};
