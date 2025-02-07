import { CountryCode } from "plaid";
import { MaskedUser } from "server";
import { Institution } from "common";
import { getClient } from "./util";

export const getInstitution = async (user: MaskedUser, id: string) => {
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

    return new Institution({
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
    });
  } catch (error) {
    console.error(error);
    console.error("Failed to get institutions data.");
  }
};
