import { Store, SessionData, Cookie } from "express-session";
import { client } from "./client";
import { index } from ".";

/**
 * The REAL `Cookie` type that's used by express-session in runtime.
 */
export type RealCookie = Omit<Cookie, "expires"> & { _expires?: Date };

/**
 * Redefines some properties as they should be stringified before storing because
 * Elasticsearch doesn't support multiple types mappings.
 */
export type StoredCookie = Omit<RealCookie, "secure" | "sameSite"> & {
  secure?: string;
  sameSite?: string;
};

/**
 * `SessionData` imported from express-session contains cookie property which is
 * `Cookie` type, which doesn't match with runtime cookie object. `RealSessionData`
 * tries to define what's actually used in runtime.
 */
export type RealSessionData = Omit<SessionData, "cookie"> & { cookie: RealCookie };

/**
 * Redefines 'cookie' property to make it compatible with Elasticsearch mappings.
 */
export type StoredSessionData = Omit<SessionData, "cookie"> & { cookie: StoredCookie };

/**
 * Searches session data by id from Elasticsearch.
 * @param session_id
 * @returns  A promise to be a StoredSessionData object.
 */
export const searchSession = async (session_id: string) => {
  const data = await client
    .get<{ session: StoredSessionData }>({ index, id: session_id })
    .catch((error) => {
      if (error.body?.found === false) return;
      throw new Error(`Failed to get session from Elasticsearch: ${session_id}`);
    });
  return data?._source?.session;
};

/**
 * Updates a session object with given session_id and session data.
 * @param session_id
 * @param session
 * @returns A promise to be an Elasticsearch response object.
 */
export const updateSession = async (session_id: string, session: StoredSessionData) => {
  return client.index({
    index,
    id: session_id,
    document: { type: "session", session },
  });
};

/**
 * Deletes a session object with given session_id.
 * @param session_id
 * @returns A promise to be an Elasticsearch response object.
 */
export const deleteSession = async (session_id: string) => {
  return client.delete({ index, id: session_id });
};

/**
 * Searches all expired session data and delete them.
 * @returns A promise to be an Elasticsearch response object.
 */
export const purgeSessions = async () => {
  const now = new Date().toISOString();
  return client.deleteByQuery({
    index,
    query: {
      bool: {
        filter: [
          { term: { type: "session" } },
          { range: { "session.cookie._expires": { lte: now } } },
        ],
      },
    },
  });
};

/**
 * Can be passed to 'store' option of express-session middleware to achieve persistent
 * session memory.
 */
export class ElasticsearchSessionStore extends Store {
  constructor() {
    super();
    this.autoRemoveScheduler();
  }

  /**
   * Repeatedly run every hour to remove expired session data.
   */
  private autoRemoveScheduler = () => {
    purgeSessions().catch(console.error);
    setTimeout(this.autoRemoveScheduler, 1000 * 60 * 60);
  };

  /**
   * Gets session with given session_id.
   * @param session_id
   * @param callback
   * @returns
   */
  get = async (
    session_id: string,
    callback: (err: any, session?: RealSessionData | null) => void
  ) => {
    try {
      const session = await searchSession(session_id);

      if (!session) {
        callback(null, null);
        return;
      }

      const { cookie: storedCookie } = session;
      const { _expires, secure, sameSite } = storedCookie;
      if (!_expires || new Date(_expires) < new Date()) {
        this.destroy(session_id);
        return callback(null, null);
      }

      const cookie: RealCookie = {
        ...storedCookie,
        _expires: _expires && new Date(_expires),
        secure: secure && JSON.parse(secure),
        sameSite: sameSite && JSON.parse(sameSite),
      };

      return callback(null, { ...session, cookie });
    } catch (error) {
      return callback(error);
    }
  };

  /**
   * Sets session with given session_id and session object.
   * @param session_id
   * @param session
   * @param callback
   */
  set = async (session_id: string, session: RealSessionData, callback?: (err?: any) => void) => {
    if (!callback) return;

    try {
      const { cookie } = session;
      const { secure, sameSite } = cookie;

      const storedCookie: StoredCookie = {
        ...cookie,
        secure: JSON.stringify(secure),
        sameSite: JSON.stringify(sameSite),
      };

      await updateSession(session_id, { ...session, cookie: storedCookie });

      callback(null);
    } catch (error) {
      return callback(error);
    }
  };

  /**
   * Removes session data from Elasticsearch by given session_id.
   * @param session_id
   * @param callback
   * @returns
   */
  destroy = async (session_id: string, callback?: (err?: any) => void) => {
    if (!callback) return;
    try {
      await deleteSession(session_id);
      return callback(null);
    } catch (error) {
      return callback(error);
    }
  };
}
