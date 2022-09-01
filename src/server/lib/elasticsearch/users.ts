import bcrypt from "bcrypt";
import { DeepPartial } from "client";
import { deepFlatten } from "server";
import { client, index } from "./client";

export interface MaskedUser {
  user_id: string;
  username: string;
}

export type User = MaskedUser & { password: string };

export const maskUser = (user: User): MaskedUser => {
  const { user_id, username } = user;
  return { user_id, username };
};

type IndexUserInput = Omit<User, "user_id"> & {
  user_id?: string;
};

/**
 * Creates or updates a document that represents a user.
 * If id is provided and already exists in the index, existing document will be updated.
 * Otherwise, new document is created in either provided id or auto-generated one.
 * This operation doesn't ensure created user's properties are unique.
 * Therefore an extra validation is recommended when creating a new user.
 * @param user
 * @returns A promise to be an Elasticsearch response object
 */
export const indexUser = async (user: IndexUserInput) => {
  const { user_id, password } = user;

  if (password) user.password = await bcrypt.hash(password, 10);
  if (user_id) delete user.user_id;

  return client.index({
    index,
    id: user_id,
    document: { type: "user", user },
  });
};

/**
 * Searches for a user. Prints out warning log if multiple users are found.
 * @param user
 * @returns A promise to be a User object
 */
export const searchUser = async (
  user: Partial<MaskedUser>
): Promise<User | undefined> => {
  let hitUser: User | undefined;
  let user_id: string;

  if (user.user_id) {
    const response = await client.get<{ user: User }>({
      index,
      id: user.user_id,
    });

    hitUser = response._source?.user;
    user_id = response._id;
  } else {
    const filter: { term: any }[] = [{ term: { type: "user" } }];

    const flatUser = deepFlatten(user);
    for (const key in flatUser) {
      filter.push({ term: { [`user.${key}`]: flatUser[key] } });
    }

    const response = await client.search<{ user: User }>({
      index,
      query: { bool: { filter } },
    });

    const { hits } = response.hits;

    if (hits.length > 1) {
      console.warn("Multiple users are found by user:", user);
    }

    const hit = hits[0];
    hitUser = hit?._source?.user;
    user_id = hit?._id;
  }

  if (!hitUser || !user_id) return;

  const filledHitUser = { ...hitUser, user_id };

  return filledHitUser;
};

export type PartialUser = { user_id: string } & DeepPartial<User>;

/**
 * Updates user document with given object.
 * @param user
 * @returns A promise to be an Elasticsearch response object
 */
export const updateUser = async (user: PartialUser) => {
  if (!user) return;
  const { user_id } = user;

  const source = `
  if (ctx._source.type == "user") {
    ${Object.entries(deepFlatten(user)).reduce((acc, [key, value]) => {
      if (key === "user_id") return acc;
      return acc + `ctx._source.user.${key} = ${JSON.stringify(value)};\n`;
    }, "")}
  } else {
    throw new Exception("Found document is not user type.");
  }
  `;

  const script = { source, lang: "painless" };

  return client.update({ id: user_id, index, script });
};
