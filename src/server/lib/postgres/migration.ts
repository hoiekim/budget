/**
 * Automatic schema migration for PostgreSQL.
 * Compares TypeScript schema definitions with actual database columns
 * and automatically adds missing columns on startup.
 *
 * Ported from inbox (hoiekim/inbox) for consistency.
 */

import { PoolClient } from "pg";
import { builtinsTypes } from "pg-types";
import { pool } from "./client";
import { Schema } from "./models/base";

/**
 * Normalized PostgreSQL type names used for comparison.
 * Based on builtinsTypes from pg-types, plus common SQL aliases.
 * We normalize to these canonical forms for consistent comparison.
 */
type NormalizedPgType =
  | builtinsTypes
  | "INTEGER"    // Alias for INT4
  | "BIGINT"     // Alias for INT8
  | "SMALLINT"   // Alias for INT2
  | "BOOLEAN"    // Alias for BOOL (SQL standard name)
  | "FLOAT"      // Normalized from REAL/DOUBLE PRECISION
  | "CHAR"       // Alias for BPCHAR
  | `${string}[]`; // Array types

// Mapping from TypeScript schema definitions to PostgreSQL types
interface ColumnInfo {
  name: string;
  pgType: NormalizedPgType;
  nullable: boolean;
  hasDefault: boolean;
  defaultValue: string | null;
}

interface DbColumn {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
}

/**
 * Parse a TypeScript schema column definition into normalized components.
 */
export function parseColumnDefinition(definition: string): ColumnInfo | null {
  // Extract the type part (before any constraints)
  const parts = definition.trim().toUpperCase().split(/\s+/);
  if (parts.length === 0) return null;

  const hasDefault = /DEFAULT\s+/i.test(definition);
  const defaultMatch = definition.match(/DEFAULT\s+(.+?)(?:\s+(?:NOT\s+NULL|NULL|PRIMARY|REFERENCES|CHECK|UNIQUE)|$)/i);
  const defaultValue = defaultMatch ? defaultMatch[1].trim() : null;

  // Normalize the type to NormalizedPgType
  // Use rawType for input string comparisons, then assign to normalized pgType
  const rawType = parts[0];
  // Check for multi-word types like "DOUBLE PRECISION"
  const twoWordType = parts.length > 1 ? `${parts[0]} ${parts[1]}` : "";
  let pgType: NormalizedPgType;
  
  // Handle common type variations - normalize to canonical forms
  if (rawType.startsWith("VARCHAR")) {
    pgType = "VARCHAR";
  } else if (rawType.startsWith("CHAR") && rawType !== "CHAR") {
    pgType = "CHAR";
  } else if (rawType === "TIMESTAMPTZ" || rawType === "TIMESTAMP") {
    pgType = "TIMESTAMP";
  } else if (rawType === "INTEGER" || rawType === "INT") {
    pgType = "INTEGER";
  } else if (rawType === "BIGINT") {
    pgType = "BIGINT";
  } else if (rawType === "SERIAL") {
    pgType = "INTEGER"; // SERIAL is INTEGER with sequence
  } else if (rawType === "BIGSERIAL") {
    pgType = "BIGINT";
  } else if (rawType.startsWith("DECIMAL") || rawType.startsWith("NUMERIC")) {
    pgType = "NUMERIC"; // DECIMAL/NUMERIC with any precision are equivalent
  } else if (rawType === "REAL" || rawType === "FLOAT" || rawType === "FLOAT4" || rawType === "FLOAT8" || twoWordType === "DOUBLE PRECISION") {
    pgType = "FLOAT"; // Float variations all normalize to FLOAT
  } else {
    pgType = rawType as NormalizedPgType;
  }

  // Check nullable
  const notNull = /NOT\s+NULL/i.test(definition);
  const nullable = !notNull;

  return {
    name: "",
    pgType,
    nullable,
    hasDefault,
    defaultValue,
  };
}

/**
 * Map PostgreSQL data_type and udt_name to normalized type for comparison.
 * @internal Exported for testing
 */
export function normalizeDbType(dataType: string, udtName: string): NormalizedPgType {
  const type = dataType.toUpperCase();
  const udt = udtName.toUpperCase();

  // Handle user-defined types (like JSONB)
  if (type === "USER-DEFINED") {
    if (udt === "TSVECTOR") return "TSVECTOR";
    return udt as NormalizedPgType;
  }

  // Normalize timestamp types
  if (type.includes("TIMESTAMP")) return "TIMESTAMP";
  
  // Normalize character types
  if (type.includes("CHARACTER VARYING")) return "VARCHAR";
  if (type.includes("CHARACTER")) return "CHAR";
  
  // Normalize text
  if (type === "TEXT") return "TEXT";
  
  // Normalize numeric types
  if (type === "INTEGER") return "INTEGER";
  if (type === "BIGINT") return "BIGINT";
  if (type === "SMALLINT") return "SMALLINT";
  if (type === "BOOLEAN") return "BOOLEAN";
  if (type === "NUMERIC" || type === "DECIMAL") return "NUMERIC";
  if (type === "REAL" || type === "DOUBLE PRECISION") return "FLOAT";
  
  // UUID
  if (type === "UUID") return "UUID";
  
  // JSON types
  if (type === "JSONB" || udt === "JSONB") return "JSONB";
  if (type === "JSON" || udt === "JSON") return "JSON";

  // Array types
  if (type === "ARRAY") return `${normalizeDbType(udtName.replace(/^_/, ""), udtName)}[]`;

  return type as NormalizedPgType;
}

/**
 * Check if two types are compatible.
 * Returns true if they're the same or one is a compatible variation.
 * @internal Exported for testing
 */
export function typesCompatible(schemaType: NormalizedPgType, dbType: NormalizedPgType): boolean {
  // Direct match
  if (schemaType === dbType) return true;
  
  // VARCHAR/TEXT are often interchangeable
  if ((schemaType === "VARCHAR" || schemaType === "TEXT") && 
      (dbType === "VARCHAR" || dbType === "TEXT")) return true;
  
  // JSON and JSONB
  if ((schemaType === "JSON" || schemaType === "JSONB") && 
      (dbType === "JSON" || dbType === "JSONB")) return true;

  // INTEGER variations (SERIAL/BIGSERIAL normalized to INTEGER/BIGINT during parsing)
  if ((schemaType === "INTEGER" || schemaType === "INT4") &&
      (dbType === "INTEGER" || dbType === "INT4")) return true;

  // NUMERIC variations (DECIMAL normalized to NUMERIC during parsing)
  if (schemaType === "NUMERIC" && dbType === "NUMERIC") return true;

  // FLOAT variations (REAL/DOUBLE PRECISION normalized to FLOAT during parsing)
  if ((schemaType === "FLOAT" || schemaType === "FLOAT8") &&
      (dbType === "FLOAT" || dbType === "FLOAT8")) return true;

  return false;
}

/**
 * Query existing columns for a table from PostgreSQL information_schema.
 */
async function getExistingColumns(
  tableName: string,
  client?: PoolClient
): Promise<Map<string, DbColumn>> {
  const queryFn = client || pool;
  const result = await queryFn.query<DbColumn>(`
    SELECT column_name, data_type, udt_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = $1 AND table_schema = 'public'
    ORDER BY ordinal_position
  `, [tableName]);

  const columns = new Map<string, DbColumn>();
  for (const row of result.rows) {
    columns.set(row.column_name, row);
  }
  return columns;
}

/**
 * Build an ALTER TABLE statement to add a missing column.
 * @internal Exported for testing
 */
export function buildAddColumnSql(tableName: string, columnName: string, definition: string): string {
  // Clean the definition for ALTER TABLE context
  // Remove PRIMARY KEY (can't add via ALTER TABLE easily)
  let cleanDef = definition.replace(/PRIMARY\s+KEY/gi, "");
  
  // For NOT NULL columns without defaults, we need to add a default
  const hasNotNull = /NOT\s+NULL/i.test(definition);
  const hasDefault = /DEFAULT\s+/i.test(definition);
  
  if (hasNotNull && !hasDefault) {
    // When adding a NOT NULL column to an existing table with data, PostgreSQL
    // requires a default value. We infer a sensible default based on the column type.
    // NOTE: This means existing rows will get these default values, which may not
    // be semantically correct for all use cases (e.g., status=0 might not be valid).
    // If precise control is needed, add explicit DEFAULT in the schema definition.
    const type = definition.split(/\s+/)[0].toUpperCase();
    let defaultValue = "''"; // Default to empty string
    
    if (type === "BOOLEAN") defaultValue = "FALSE";
    else if (type === "INTEGER" || type === "BIGINT" || type === "SMALLINT") defaultValue = "0";
    else if (type === "UUID") defaultValue = "gen_random_uuid()";
    else if (type.includes("TIMESTAMP")) defaultValue = "CURRENT_TIMESTAMP";
    else if (type === "JSONB") defaultValue = "'{}'::jsonb";
    else if (type === "JSON") defaultValue = "'{}'::json";
    else if (type === "TEXT" || type.startsWith("VARCHAR")) defaultValue = "''";
    
    cleanDef = cleanDef.replace(/NOT\s+NULL/i, `DEFAULT ${defaultValue} NOT NULL`);
  }

  return `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${columnName} ${cleanDef.trim()}`;
}

export interface MigrationResult {
  table: string;
  added: string[];
  warnings: string[];
  errors: string[];
}

/**
 * Migrate a single table to match its schema definition.
 * Internal version that accepts a client for transaction support.
 */
async function migrateTableWithClient(
  client: PoolClient,
  tableName: string,
  schema: Schema
): Promise<MigrationResult> {
  const result: MigrationResult = {
    table: tableName,
    added: [],
    warnings: [],
    errors: [],
  };

  // Get existing columns from database
  const existingColumns = await getExistingColumns(tableName, client);
  
  // If table doesn't exist yet, nothing to migrate (CREATE TABLE will handle it)
  if (existingColumns.size === 0) {
    return result;
  }

  // Check each column in the schema
  for (const [columnName, definition] of Object.entries(schema)) {
    const existingCol = existingColumns.get(columnName);
    
    if (!existingCol) {
      // Column is missing - add it
      try {
        const sql = buildAddColumnSql(tableName, columnName, definition);
        await client.query(sql);
        result.added.push(columnName);
        console.info(`[Migration] Added column ${tableName}.${columnName}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        result.errors.push(`Failed to add ${columnName}: ${msg}`);
      }
    } else {
      // Column exists - check for type compatibility
      const parsed = parseColumnDefinition(definition);
      if (parsed) {
        const dbType = normalizeDbType(existingCol.data_type, existingCol.udt_name);
        if (!typesCompatible(parsed.pgType, dbType)) {
          result.errors.push(
            `Type mismatch for ${columnName}: schema expects ${parsed.pgType}, database has ${dbType}`
          );
        }
      }
    }
  }

  // Check for extra columns in DB that aren't in schema
  for (const [columnName] of existingColumns) {
    if (!schema[columnName]) {
      result.warnings.push(
        `Extra column in database: ${columnName} (not in schema)`
      );
    }
  }

  return result;
}

/**
 * Migrate a single table to match its schema definition.
 * Public API - uses pool directly (no transaction).
 */
export async function migrateTable(
  tableName: string,
  schema: Schema
): Promise<MigrationResult> {
  const client = await pool.connect();
  try {
    return await migrateTableWithClient(client, tableName, schema);
  } finally {
    client.release();
  }
}

/**
 * Run migrations for all provided tables within a transaction.
 * Returns true if successful, throws on fatal errors.
 * Uses a transaction to ensure atomicity - either all migrations succeed or none do.
 */
export async function runMigrations(
  tables: Array<{ name: string; schema: Schema }>
): Promise<void> {
  console.info("[Migration] Starting schema migration check...");
  
  // Use a dedicated client for the transaction
  const client = await pool.connect();
  
  try {
    await client.query("BEGIN");
    
    const allResults: MigrationResult[] = [];
    const fatalErrors: string[] = [];

    for (const table of tables) {
      const result = await migrateTableWithClient(client, table.name, table.schema);
      allResults.push(result);
      
      // Type mismatches are fatal
      if (result.errors.length > 0) {
        fatalErrors.push(...result.errors.map(e => `${table.name}: ${e}`));
      }
    }

    // Log summary
    const totalAdded = allResults.reduce((sum, r) => sum + r.added.length, 0);
    const totalWarnings = allResults.reduce((sum, r) => sum + r.warnings.length, 0);

    if (totalAdded > 0) {
      console.info(`[Migration] Added ${totalAdded} column(s) across ${allResults.filter(r => r.added.length > 0).length} table(s)`);
    }

    if (totalWarnings > 0) {
      for (const result of allResults) {
        for (const warning of result.warnings) {
          console.warn(`[Migration] ${result.table}: ${warning}`);
        }
      }
    }

    // Fatal errors stop startup
    if (fatalErrors.length > 0) {
      const errorMsg = `Schema migration failed:\n${fatalErrors.join("\n")}`;
      console.error(`[Migration] ${errorMsg}`);
      await client.query("ROLLBACK");
      throw new Error(errorMsg);
    }

    await client.query("COMMIT");
    console.info("[Migration] Schema migration check complete.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
