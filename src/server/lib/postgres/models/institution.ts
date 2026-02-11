import { JSONInstitution, isString, isNullableString, isNullableDate, isNullableObject } from "common";
import { INSTITUTION_ID, NAME, RAW, UPDATED, INSTITUTIONS } from "./common";
import { Schema, AssertTypeFn, createAssertType, Model, createTable } from "./base";
import { toDate } from "../util";

export class InstitutionModel extends Model<JSONInstitution> {
  institution_id: string; name: string; updated: Date;

  constructor(data: unknown) {
    super();
    InstitutionModel.assertType(data);
    const r = data as Record<string, unknown>;
    this.institution_id = r.institution_id as string;
    this.name = (r.name as string) || "Unknown";
    this.updated = r.updated ? toDate(r.updated) : new Date();
  }

  toJSON(): JSONInstitution {
    return {
      institution_id: this.institution_id, name: this.name, products: [], country_codes: [],
      url: null, primary_color: null, logo: null, routing_numbers: [], oauth: false, status: null,
    };
  }

  static toRow(i: Partial<JSONInstitution>): Record<string, unknown> {
    const r: Record<string, unknown> = {};
    if (i.institution_id !== undefined) r.institution_id = i.institution_id;
    if (i.name !== undefined) r.name = i.name;
    r.raw = i;
    return r;
  }

  static assertType: AssertTypeFn<Record<string, unknown>> = createAssertType("InstitutionModel", {
    institution_id: isString, name: isNullableString, raw: isNullableObject, updated: isNullableDate,
  });
}

export const institutionsTable = createTable({
  name: INSTITUTIONS,
  primaryKey: INSTITUTION_ID,
  schema: {
    [INSTITUTION_ID]: "VARCHAR(255) PRIMARY KEY", [NAME]: "VARCHAR(255)", [RAW]: "JSONB",
    [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  } as Schema<Record<string, unknown>>,
  ModelClass: InstitutionModel,
});

export const institutionColumns = Object.keys(institutionsTable.schema);
