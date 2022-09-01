import { Store, SessionData, Cookie } from "express-session";
import { client, index } from "server";

/**
 * The REAL `Cookie` type that's used in runtime.
 */
export type RealCookie = Omit<Cookie, "expires"> & { _expires?: Date };

/**
 * Redefines some properties as they should be stringified before storing because
 * Elasticsearch doesn't support multiple types mappings.
 */
export type StoredCookie = Omit<Omit<RealCookie, "secure">, "sameSite"> & {
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
 * Redefines 'cookie' property to make it compatible.
 */
export type StoredSessionData = Omit<SessionData, "cookie"> & { cookie: StoredCookie };

/**
 * Can be passed to 'store' option of express-session middleware to achieve persistent
 * session memory.
 */
export class ElasticsearchSessionStore extends Store {
  /**
   * Calls Elasticsearch client method to get session with given session id.
   * @param sid
   * @param callback
   * @returns
   */
  get = async (
    sid: string,
    callback: (err: any, session?: RealSessionData | null) => void
  ) => {
    try {
      const data = await client
        .get<{ session: StoredSessionData }>({ index, id: sid })
        .catch((error) => {
          if (error.body?.found === false) return;
          throw new Error(`Failed to get session from Elasticsearch: ${sid}`);
        });
      const source = data?._source;
      if (!source) {
        callback(null, null);
        return;
      }

      const { session } = source;
      const { cookie: storedCookie } = session;
      const { _expires, secure, sameSite } = storedCookie;
      if (!_expires || new Date(_expires) < new Date()) {
        this.destroy(sid);
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
   * Calls Elasticsearch client method to set session with given session id.
   * @param sid
   * @param session
   * @param callback
   */
  set = async (sid: string, session: RealSessionData, callback?: (err?: any) => void) => {
    if (!callback) return;

    try {
      const { cookie } = session;
      const { secure, sameSite } = cookie;

      const storedCookie: StoredCookie = {
        ...cookie,
        secure: JSON.stringify(secure),
        sameSite: JSON.stringify(sameSite),
      };

      await client.index({
        index,
        id: sid,
        document: { type: "session", session: { ...session, cookie: storedCookie } },
      });

      callback(null);
    } catch (error) {
      return callback(error);
    }
  };

  /**
   * Removes session data from Elasticsearch by given session id
   * @param sid
   * @param callback
   * @returns
   */
  destroy = async (sid: string, callback?: (err?: any) => void) => {
    if (!callback) return;
    try {
      await client.delete({ index, id: sid });
      return callback(null);
    } catch (error) {
      return callback(error);
    }
  };
}
