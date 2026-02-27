import { CountryCode } from "plaid";
import { MaskedUser } from "server";
import { JSONInstitution } from "common";
import { getClient } from "./util";
import { logger } from "../logger";

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
