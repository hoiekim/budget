/**
 * Utility functions for PostgreSQL operations.
 * Provides translation between nested ES document structure and flat Postgres columns.
 */

/**
 * Converts a nested object to flat key-value pairs using underscore notation.
 * Example: { balances: { current: 100 } } → { balances_current: 100 }
 */
export function flattenObject(
  obj: Record<string, any>,
  prefix: string = "",
  result: Record<string, any> = {}
): Record<string, any> {
  for (const [key, value] of Object.entries(obj)) {
    const flatKey = prefix ? `${prefix}_${key}` : key;

    if (value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      flattenObject(value, flatKey, result);
    } else {
      result[flatKey] = value;
    }
  }
  return result;
}

/**
 * Converts flat key-value pairs back to nested object structure.
 * Example: { balances_current: 100 } → { balances: { current: 100 } }
 */
export function unflattenObject(obj: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};

  for (const [flatKey, value] of Object.entries(obj)) {
    const keys = flatKey.split("_");
    let current = result;

    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!(key in current)) {
        current[key] = {};
      }
      current = current[key];
    }

    current[keys[keys.length - 1]] = value;
  }

  return result;
}

/**
 * Converts camelCase to snake_case.
 */
export function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Converts snake_case to camelCase.
 */
export function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Builds a dynamic UPDATE query from a partial object.
 * Only includes fields that are defined (not undefined).
 * 
 * @param tableName - The table to update
 * @param primaryKey - The primary key column name
 * @param primaryKeyValue - The value of the primary key
 * @param data - The data to update (undefined values are skipped)
 * @param options - Additional options
 * @returns Object with query string and values array
 */
export function buildUpdateQuery(
  tableName: string,
  primaryKey: string,
  primaryKeyValue: string,
  data: Record<string, any>,
  options: {
    additionalWhere?: { column: string; value: any };
    returning?: string[];
  } = {}
): { query: string; values: any[] } | null {
  const setClauses: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  // Always update the 'updated' timestamp
  setClauses.push(`updated = CURRENT_TIMESTAMP`);

  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      setClauses.push(`${key} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    }
  }

  // If only 'updated' timestamp would be set, skip the update
  if (setClauses.length === 1) {
    return null;
  }

  // Add primary key value
  values.push(primaryKeyValue);
  const pkParam = paramIndex;
  paramIndex++;

  let query = `UPDATE ${tableName} SET ${setClauses.join(", ")} WHERE ${primaryKey} = $${pkParam}`;

  // Add additional WHERE clause if provided
  if (options.additionalWhere) {
    values.push(options.additionalWhere.value);
    query += ` AND ${options.additionalWhere.column} = $${paramIndex}`;
    paramIndex++;
  }

  // Add RETURNING clause if provided
  if (options.returning && options.returning.length > 0) {
    query += ` RETURNING ${options.returning.join(", ")}`;
  }

  return { query, values };
}

/**
 * Builds a dynamic INSERT query with ON CONFLICT handling.
 * 
 * @param tableName - The table to insert into
 * @param primaryKey - The primary key column name
 * @param data - The data to insert
 * @param updateColumns - Columns to update on conflict (if empty, do nothing on conflict)
 * @returns Object with query string and values array
 */
export function buildUpsertQuery(
  tableName: string,
  primaryKey: string,
  data: Record<string, any>,
  updateColumns: string[] = []
): { query: string; values: any[] } {
  const columns: string[] = [];
  const placeholders: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  // Always add 'updated' timestamp
  columns.push("updated");
  placeholders.push("CURRENT_TIMESTAMP");

  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      columns.push(key);
      placeholders.push(`$${paramIndex}`);
      values.push(value);
      paramIndex++;
    }
  }

  let query = `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`;

  if (updateColumns.length > 0) {
    const updateClauses = updateColumns
      .filter(col => col !== primaryKey)
      .map(col => `${col} = EXCLUDED.${col}`);
    updateClauses.push("updated = CURRENT_TIMESTAMP");
    query += ` ON CONFLICT (${primaryKey}) DO UPDATE SET ${updateClauses.join(", ")}`;
  } else {
    query += ` ON CONFLICT (${primaryKey}) DO NOTHING`;
  }

  query += ` RETURNING ${primaryKey}`;

  return { query, values };
}

/**
 * Maps Postgres row (snake_case, flat) to ES document format (camelCase, nested).
 */
export function rowToDocument<T>(
  row: Record<string, any>,
  nestedFields: string[] = []
): T {
  const result: Record<string, any> = {};

  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) continue;

    // Check if this is a nested field prefix
    const nestedPrefix = nestedFields.find(f => key.startsWith(f + "_"));
    
    if (nestedPrefix) {
      // Initialize nested object if needed
      if (!result[nestedPrefix]) {
        result[nestedPrefix] = {};
      }
      // Get the nested key (after the prefix)
      const nestedKey = key.slice(nestedPrefix.length + 1);
      result[nestedPrefix][toCamelCase(nestedKey)] = value;
    } else {
      result[toCamelCase(key)] = value;
    }
  }

  return result as T;
}

/**
 * Maps ES document format to Postgres row format.
 */
export function documentToRow(
  doc: Record<string, any>,
  nestedFields: string[] = []
): Record<string, any> {
  const result: Record<string, any> = {};

  for (const [key, value] of Object.entries(doc)) {
    if (value === undefined) continue;

    const snakeKey = toSnakeCase(key);

    // Check if this is a nested field
    if (nestedFields.includes(snakeKey) && typeof value === "object" && !Array.isArray(value)) {
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        if (nestedValue !== undefined) {
          result[`${snakeKey}_${toSnakeCase(nestedKey)}`] = nestedValue;
        }
      }
    } else {
      result[snakeKey] = value;
    }
  }

  return result;
}
