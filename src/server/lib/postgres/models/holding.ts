import {
  JSONHolding,
  isString,
  isUndefined,
  isNullableString,
  isNullableNumber,
  isNullableBoolean,
  isNullableObject,
} from "common";
import {
  HOLDING_ID,
  USER_ID,
  ACCOUNT_ID,
  SECURITY_ID,
  INSTITUTION_PRICE,
  INSTITUTION_PRICE_AS_OF,
  INSTITUTION_VALUE,
  COST_BASIS,
  QUANTITY,
  ISO_CURRENCY_CODE,
  RAW,
  UPDATED,
  IS_DELETED,
  HOLDINGS,
  USERS,
} from "./common";
import { Model, RowValueType, createTable } from "./base";

const holdingSchema = {
  [HOLDING_ID]: "VARCHAR(255) PRIMARY KEY",
  [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT NOT NULL`,
  [ACCOUNT_ID]: "VARCHAR(255) NOT NULL",
  [SECURITY_ID]: "VARCHAR(255) NOT NULL",
  [INSTITUTION_PRICE]: "DECIMAL(15, 6)",
  [INSTITUTION_PRICE_AS_OF]: "DATE",
  [INSTITUTION_VALUE]: "DECIMAL(15, 2)",
  [COST_BASIS]: "DECIMAL(15, 2)",
  [QUANTITY]: "DECIMAL(15, 6)",
  [ISO_CURRENCY_CODE]: "VARCHAR(10)",
  [RAW]: "JSONB",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
};

type HoldingSchema = typeof holdingSchema;
type HoldingRow = { [k in keyof HoldingSchema]: RowValueType };

export class HoldingModel extends Model<JSONHolding, HoldingSchema> implements HoldingRow {
  holding_id!: string;
  user_id!: string;
  account_id!: string;
  security_id!: string;
  institution_price!: number;
  institution_price_as_of!: string | null;
  institution_value!: number;
  cost_basis!: number;
  quantity!: number;
  iso_currency_code!: string;
  raw!: object | null;
  updated!: string | null;
  is_deleted!: boolean;

  static typeChecker = {
    holding_id: isString,
    user_id: isString,
    account_id: isString,
    security_id: isString,
    institution_price: isNullableNumber,
    institution_price_as_of: isNullableString,
    institution_value: isNullableNumber,
    cost_basis: isNullableNumber,
    quantity: isNullableNumber,
    iso_currency_code: isNullableString,
    raw: isNullableObject,
    updated: isNullableString,
    is_deleted: isNullableBoolean,
  };

  constructor(data: unknown) {
    super(data, HoldingModel.typeChecker);
  }

  toJSON(): JSONHolding {
    return {
      holding_id: this.holding_id,
      account_id: this.account_id,
      security_id: this.security_id,
      institution_price: this.institution_price,
      institution_price_as_of: this.institution_price_as_of,
      institution_value: this.institution_value,
      cost_basis: this.cost_basis,
      quantity: this.quantity,
      iso_currency_code: this.iso_currency_code,
      unofficial_currency_code: null,
    };
  }

  static fromJSON(
    h: Partial<JSONHolding> & { holding_id?: string },
    user_id: string,
  ): Partial<HoldingRow> {
    const r: Partial<HoldingRow> = {
      user_id,
      holding_id: h.holding_id || `${h.account_id}-${h.security_id}`,
    };
    if (!isUndefined(h.account_id)) r.account_id = h.account_id;
    if (!isUndefined(h.security_id)) r.security_id = h.security_id;
    if (!isUndefined(h.institution_price)) r.institution_price = h.institution_price;
    if (!isUndefined(h.institution_price_as_of))
      r.institution_price_as_of = h.institution_price_as_of;
    if (!isUndefined(h.institution_value)) r.institution_value = h.institution_value;
    if (!isUndefined(h.cost_basis)) r.cost_basis = h.cost_basis;
    if (!isUndefined(h.quantity)) r.quantity = h.quantity;
    if (!isUndefined(h.iso_currency_code)) r.iso_currency_code = h.iso_currency_code;
    r.raw = h;
    return r;
  }
}

export const holdingsTable = createTable({
  name: HOLDINGS,
  primaryKey: HOLDING_ID,
  schema: holdingSchema,
  indexes: [{ column: USER_ID }, { column: ACCOUNT_ID }, { column: SECURITY_ID }],
  ModelClass: HoldingModel,
});

export const holdingColumns = Object.keys(holdingsTable.schema);
