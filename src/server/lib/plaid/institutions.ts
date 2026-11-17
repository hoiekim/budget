import { CountryCode } from "plaid";
import { MaskedUser, logger } from "server";
import { JSONInstitution, Queue, QueueWaitTimeoutError } from "common";
import { PlaidCallOptions, getClient, plaidQueue } from "./util";

// A sub-cap inside the shared Plaid gate, so one institutions batch cannot
// take every slot from the sync paths.
const institutionQueue = new Queue({ maxInflight: 4 });

const getInstitution = async (
  user: MaskedUser,
  id: string,
  getClientFn: typeof getClient,
  deadline: number,
): Promise<JSONInstitution | undefined> => {
  const client = getClientFn(user);
  const maxWaitMs = deadline === Infinity ? undefined : Math.max(1, deadline - Date.now());

  try {
    const response = await plaidQueue.add(
      () =>
        client.institutionsGetById({
          institution_id: id,
          country_codes: [CountryCode.Us],
        }),
      { maxWaitMs },
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
    if (error instanceof QueueWaitTimeoutError) throw error;
    logger.error("Failed to get institution data", { institutionId: id }, error);
  }
};

/**
 * Resolve a set of institution ids through the shared concurrency gate. Ids
 * Plaid cannot resolve are absent from the result rather than failing the batch.
 * `maxWaitMs` bounds the whole batch, both queues included, not each id.
 */
export const getInstitutionsByIds = async (
  user: MaskedUser,
  ids: string[],
  { getClient: getClientFn = getClient, maxWaitMs }: PlaidCallOptions = {},
): Promise<JSONInstitution[]> => {
  const deadline = maxWaitMs && maxWaitMs > 0 ? Date.now() + maxWaitMs : Infinity;
  const settled = await Promise.all(
    ids.map((id) =>
      institutionQueue
        .add(() => getInstitution(user, id, getClientFn, deadline), { maxWaitMs })
        .catch((error) => {
          if (!(error instanceof QueueWaitTimeoutError)) throw error;
          logger.warn("Institution lookup shed by the Plaid concurrency gate", { institutionId: id });
          return undefined;
        }),
    ),
  );
  return settled.filter((institution): institution is JSONInstitution => !!institution);
};
