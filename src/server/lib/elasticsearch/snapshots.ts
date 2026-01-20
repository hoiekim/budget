import { flatten, MaskedUser } from "server";
import { SnapshotData, DeepPartial, Snapshot, Account, Holding, Security } from "common";
import { client } from "./client";
import { getUpdateSnapshotScript } from "./scripts";
import { index, RemovedAccount } from ".";

export interface SearchSnapshotsOptions {
  range?: DateRange;
  query?: DeepPartial<SnapshotData>;
}

interface DateRange {
  start: Date;
  end: Date;
}

export const searchSnapshots = async (user?: MaskedUser, options?: SearchSnapshotsOptions) => {
  const { range, query } = options || {};
  if (!user && !query) return [];
  const { start, end } = range || {};
  const isValidRange = start && end && start < end;

  const filter: any[] = [{ term: { type: "snapshot" } }];

  if (isValidRange) {
    filter.push({
      bool: {
        filter: [
          { range: { updated: { gte: start.toISOString() } } },
          { range: { updated: { lt: end.toISOString() } } },
        ],
      },
    });
  }

  if (user) {
    const { user_id } = user;
    filter.push({ term: { "user.user_id": user_id } });
  }

  if (query) {
    filter.push(
      ...Object.entries(flatten(query)).map(([key, value]) => ({
        term: { [key]: value },
      }))
    );
  }

  const response = await client.search<SnapshotData>({
    index,
    from: 0,
    size: 10000,
    query: { bool: { filter } },
  });

  const snapshots: SnapshotData[] = [];

  response.hits.hits.forEach((e) => {
    const source = e._source;
    if (!source) return;
    const { snapshot } = source;
    if ("account" in source) {
      const { account, user } = source;
      snapshots.push({ snapshot, user, account });
    } else if ("holding" in source) {
      const { holding, user } = source;
      snapshots.push({ snapshot, user, holding });
    } else if ("security" in source) {
      const { security } = source;
      snapshots.push({ snapshot, security });
    }
  });

  return snapshots;
};

export type PartialSnapshot = Partial<Snapshot> & { snapshot_id: string };
export interface PartialAccountSnapshot {
  snapshot: PartialSnapshot;
  user: { user_id: string };
  account: Partial<Account>;
}
export interface PartialHoldingSnapshot {
  snapshot: PartialSnapshot;
  user: { user_id: string };
  holding: Partial<Holding>;
}
export interface PartialSecuritySnapshot {
  snapshot: PartialSnapshot;
  security: Partial<Security>;
}
export type PartialSnapshotData =
  | PartialAccountSnapshot
  | PartialHoldingSnapshot
  | PartialSecuritySnapshot;

export const upsertSnapshots = async (docs: PartialSnapshotData[], upsert: boolean = true) => {
  if (!docs.length) return [];

  const operations = docs.flatMap((doc) => {
    const { snapshot_id } = doc.snapshot;

    const bulkHead = { update: { _index: index, _id: snapshot_id } };

    const script = getUpdateSnapshotScript(doc);
    const bulkBody: any = { script };

    if (upsert) {
      const updated = new Date().toISOString();
      bulkBody.upsert = { ...doc, type: "snapshot", updated };
    }

    return [bulkHead, bulkBody];
  });

  const response = await client.bulk({ operations });

  return response.items;
};

export interface RemovedSnapshot {
  snapshot_id: string;
}

export const deleteSnapshots = async (docs: { snapshot: RemovedSnapshot }[]) => {
  if (!Array.isArray(docs) || !docs.length) return;

  const response = await client.deleteByQuery({
    index,
    query: {
      bool: {
        filter: [
          { term: { type: "snapshot" } },
          { bool: { should: docs.map((e) => ({ term: { _id: e.snapshot.snapshot_id } })) } },
        ],
      },
    },
  });

  return response;
};

export const deleteSnapshotsByUser = async (
  user: MaskedUser,
  docs: { snapshot: RemovedSnapshot }[]
) => {
  if (!Array.isArray(docs) || !docs.length) return;
  const { user_id } = user;

  const response = await client.deleteByQuery({
    index,
    query: {
      bool: {
        filter: [
          { term: { type: "snapshot" } },
          { term: { "user.user_id": user_id } },
          { bool: { should: docs.map((e) => ({ term: { _id: e.snapshot.snapshot_id } })) } },
        ],
      },
    },
  });

  return response;
};

export const deleteSnapshotsByAccount = async (
  user: MaskedUser,
  docs: { account: RemovedAccount }[]
) => {
  if (!Array.isArray(docs) || !docs.length) return;
  const { user_id } = user;

  const response = await client.deleteByQuery({
    index,
    query: {
      bool: {
        filter: [
          { term: { type: "snapshot" } },
          { term: { "user.user_id": user_id } },
          {
            bool: {
              should: docs.map((e) => ({
                term: { "account.account_id": e.account.account_id },
              })),
            },
          },
        ],
      },
    },
  });

  return response;
};
