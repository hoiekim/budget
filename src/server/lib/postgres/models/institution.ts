import { JSONInstitution, isString, isNullableString, isNullableObject } from "common";
import { INSTITUTION_ID, NAME, RAW, UPDATED, INSTITUTIONS } from "./common";
import { Model, RowValueType, createTable } from "./base";

const institutionSchema = {
  [INSTITUTION_ID]: "VARCHAR(255) PRIMARY KEY",
  [NAME]: "VARCHAR(255)",
  [RAW]: "JSONB",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
};

type InstitutionSchema = typeof institutionSchema;
type InstitutionRow = { [k in keyof InstitutionSchema]: RowValueType };

export class InstitutionModel
  extends Model<JSONInstitution, InstitutionSchema>
  implements InstitutionRow
{
  declare institution_id: string;
  declare name: string;
  declare raw: object | null;
  declare updated: string | null;

  static typeChecker = {
    institution_id: isString,
    name: isNullableString,
    raw: isNullableObject,
    updated: isNullableString,
  };

  constructor(data: unknown) {
    super(data, InstitutionModel.typeChecker);
  }

  toJSON(): JSONInstitution {
    return {
      institution_id: this.institution_id,
      name: this.name,
      products: [],
      country_codes: [],
      url: null,
      primary_color: null,
      logo: null,
      routing_numbers: [],
      oauth: false,
      status: null,
    };
  }

  static fromJSON(i: Partial<JSONInstitution>): Partial<InstitutionRow> {
    const r: Partial<InstitutionRow> = {};
    if (i.institution_id !== undefined) r.institution_id = i.institution_id;
    if (i.name !== undefined) r.name = i.name;
    r.raw = i;
    return r;
  }
}

export const institutionsTable = createTable({
  name: INSTITUTIONS,
  primaryKey: INSTITUTION_ID,
  schema: institutionSchema,
  ModelClass: InstitutionModel,
  supportsSoftDelete: false,
});

export const institutionColumns = Object.keys(institutionsTable.schema);
