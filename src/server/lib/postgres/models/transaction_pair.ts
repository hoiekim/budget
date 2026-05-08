import { JSONTransferPair, TransferPairStatus, isString, isNullableString, isNullableBoolean } from "common";
import {
  PAIR_ID,
  USER_ID,
  TRANSACTION_ID,
  TRANSACTION_ID_A,
  TRANSACTION_ID_B,
  STATUS,
  CREATED_AT,
  UPDATED,
  IS_DELETED,
  TRANSACTION_PAIRS,
  TRANSACTIONS,
  USERS,
} from "./common";
import { Model, RowValueType, createTable } from "./base";

const transactionPairSchema = {
  [PAIR_ID]: "UUID PRIMARY KEY",
  [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT NOT NULL`,
  [TRANSACTION_ID_A]: `VARCHAR(255) NOT NULL REFERENCES ${TRANSACTIONS}(${TRANSACTION_ID}) ON DELETE CASCADE`,
  [TRANSACTION_ID_B]: `VARCHAR(255) NOT NULL REFERENCES ${TRANSACTIONS}(${TRANSACTION_ID}) ON DELETE CASCADE`,
  [STATUS]: "VARCHAR(20) NOT NULL",
  [CREATED_AT]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
};

type TransactionPairSchema = typeof transactionPairSchema;
type TransactionPairRow = { [k in keyof TransactionPairSchema]: RowValueType };

export class TransactionPairModel
  extends Model<JSONTransferPair, TransactionPairSchema>
  implements TransactionPairRow
{
  declare pair_id: string;
  declare user_id: string;
  declare transaction_id_a: string;
  declare transaction_id_b: string;
  declare status: TransferPairStatus;
  declare created_at: string | null;
  declare updated: string | null;
  declare is_deleted: boolean;

  static typeChecker = {
    pair_id: isString,
    user_id: isString,
    transaction_id_a: isString,
    transaction_id_b: isString,
    status: isString,
    created_at: isNullableString,
    updated: isNullableString,
    is_deleted: isNullableBoolean,
  };

  constructor(data: unknown) {
    super(data, TransactionPairModel.typeChecker);
  }

  toJSON(): JSONTransferPair {
    return {
      pair_id: this.pair_id,
      transaction_id_a: this.transaction_id_a,
      transaction_id_b: this.transaction_id_b,
      status: this.status,
      updated: this.updated,
    };
  }
}

export const transactionPairsTable = createTable({
  name: TRANSACTION_PAIRS,
  primaryKey: PAIR_ID,
  schema: transactionPairSchema,
  constraints: [
    `CONSTRAINT transaction_pairs_pair_unique UNIQUE (${TRANSACTION_ID_A}, ${TRANSACTION_ID_B})`,
  ],
  indexes: [
    { column: USER_ID },
    { column: TRANSACTION_ID_A },
    { column: TRANSACTION_ID_B },
  ],
  ModelClass: TransactionPairModel,
});

export const transactionPairColumns = Object.keys(transactionPairsTable.schema);

/**
 * Canonicalize the (a, b) pair so the same two ids always produce the same
 * (a, b) ordering. Lets us prevent duplicate pairs without a separate hash.
 */
export const canonicalizePairIds = (
  id1: string,
  id2: string,
): { transaction_id_a: string; transaction_id_b: string } => {
  return id1 < id2
    ? { transaction_id_a: id1, transaction_id_b: id2 }
    : { transaction_id_a: id2, transaction_id_b: id1 };
};
