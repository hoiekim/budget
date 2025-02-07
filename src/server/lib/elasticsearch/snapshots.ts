import { flatten, getUpdateSnapshotScript } from "server";
import { SnapshotData, DeepPartial, Snapshot, Account, Holding, Security } from "common";
import { client } from "./client";
import { index } from ".";

export const searchSnapshots = async (query: DeepPartial<SnapshotData>) => {
  const response = await client.search<SnapshotData>({
    index,
    from: 0,
    size: 10000,
    query: {
      bool: {
        filter: [
          { term: { type: "snapshot" } },
          ...Object.entries(flatten(query)).map(([key, value]) => ({
            term: { [key]: value },
          })),
        ],
      },
    },
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

    if (upsert) bulkBody.upsert = { ...doc, type: "snapshot" };

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
