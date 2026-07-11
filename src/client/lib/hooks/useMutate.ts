import { useCallback, useMemo } from "react";
import { call, useAppContext, indexedDb, Data } from "client";
import type { StoredModel } from "client/lib/indexed-db/service";

/**
 * Contract every mutable client model exposes so `useMutate` can drive
 * its CRUD from just the class reference. Model class carries only its
 * API root; the model → `Data` slot / `StoreName` / `Dictionary` mapping
 * lives on `Data` itself (see `Data.dictOf` / `storeNameOf` / `set`).
 */
export interface MutableModel<T extends StoredModel> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new (...args: any[]): T;
  readonly apiPath: string;
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
 * State updates go through `Data.dictOf(Model).clone()` + `Data.set` —
 * the model → slot mapping lives on `Data`, so the hook body has no
 * casts and no per-model wiring beyond `Model.apiPath`.
 *
 * Not covered here: cascading deletes (Account, Connection) that touch
 * more than one dictionary — those keep their bespoke handlers until
 * we design a cascade extension.
 */
export const useMutate = <T extends StoredModel>(Model: MutableModel<T>): MutateApi<T> => {
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
        const newDict = newData.dictOf(Model).clone();
        newDict.set(instance.id, instance);
        newData.set(newDict);
        indexedDb.save(instance).catch(console.error);
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
        const newDict = newData.dictOf(Model).clone();
        newDict.delete(id);
        newData.set(newDict);
        indexedDb.remove(newData.storeNameOf(Model), id).catch(console.error);
        return newData;
      });
    },
    [Model, setData],
  );

  return useMemo(() => ({ create: upsert, update: upsert, delete: del }), [upsert, del]);
};
