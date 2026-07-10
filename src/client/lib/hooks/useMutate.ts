import { useCallback, useMemo } from "react";
import { call, useAppContext, indexedDb, StoreName, Data } from "client";
import type { Dictionary } from "client/lib/models/Data";

/**
 * Contract every mutable client model exposes so `useMutate` can drive
 * its CRUD from just the class reference:
 *
 * - `apiPath` — POST/DELETE target under `/api`.
 * - `dataField` — the `Data` field that holds this model's dictionary.
 *   Values match `StoreName.*` verbatim (`"charts"`, `"transactions"`,
 *   …), so we don't need a separate StoreName static.
 */
export interface MutableModel<T extends { readonly id: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new (...args: any[]): T;
  readonly apiPath: string;
  readonly dataField: keyof Data;
}

export interface MutateApi<T> {
  /** Upserts on the server, adds the instance to state + IDB. */
  create: (instance: T) => Promise<void>;
  /** Upserts on the server, replaces the instance in state + IDB. */
  update: (instance: T) => Promise<void>;
  /** DELETEs by id, removes from state + IDB. */
  delete: (id: string) => Promise<void>;
}

/**
 * Generic client-side mutation hook. `useMutate(Chart)` returns the
 * `{ create, update, delete }` API for that model — the hook centralizes
 * the await-call, status check, error log/throw, and the state + IDB
 * update pattern that would otherwise repeat verbatim at every
 * mutation site.
 *
 * `create` and `update` share the server contract (server routes are
 * upsert-by-id via POST), so both call the same code path here; the
 * split exists at the interface level for reader clarity at call
 * sites. Deletes go through DELETE `?id=…`.
 *
 * The state update writes back through the SAME dictionary constructor
 * that Data currently holds, so callers don't need to import the
 * per-model Dictionary class — the hook reads it off the live
 * dictionary's prototype.
 *
 * Not covered here: cascading deletes (Account, Connection) that touch
 * more than one dictionary — those keep their bespoke handlers until
 * we design a cascade extension.
 */
export const useMutate = <T extends { readonly id: string }>(
  Model: MutableModel<T>,
): MutateApi<T> => {
  const { setData } = useAppContext();

  const upsert = useCallback(
    async (instance: T) => {
      const r = await call.post(Model.apiPath, instance);
      if (r.status !== "success") {
        console.error(r.message);
        throw new Error(r.message);
      }
      setData((oldData) => {
        const newData = new Data(oldData);
        const current = newData[Model.dataField] as unknown as Dictionary<T>;
        const DictCtor = current.constructor as new (
          source?: Iterable<readonly [string, T]>,
        ) => Dictionary<T>;
        const next = new DictCtor(current);
        next.set(instance.id, instance);
        indexedDb
          .save(instance as unknown as Parameters<typeof indexedDb.save>[0])
          .catch(console.error);
        (newData[Model.dataField] as unknown as Dictionary<T>) = next;
        return newData;
      });
    },
    [Model, setData],
  );

  const del = useCallback(
    async (id: string) => {
      const r = await call.delete(`${Model.apiPath}?id=${id}`);
      if (r.status !== "success") {
        console.error(r.message);
        throw new Error(r.message);
      }
      setData((oldData) => {
        const newData = new Data(oldData);
        const current = newData[Model.dataField] as unknown as Dictionary<T>;
        const DictCtor = current.constructor as new (
          source?: Iterable<readonly [string, T]>,
        ) => Dictionary<T>;
        const next = new DictCtor(current);
        next.delete(id);
        indexedDb.remove(Model.dataField as StoreName, id).catch(console.error);
        (newData[Model.dataField] as unknown as Dictionary<T>) = next;
        return newData;
      });
    },
    [Model, setData],
  );

  return useMemo(
    () => ({ create: upsert, update: upsert, delete: del }),
    [upsert, del],
  );
};
