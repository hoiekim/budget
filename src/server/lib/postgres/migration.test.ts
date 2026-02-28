/**
 * Unit tests for migration.ts
 * Tests the pure functions that handle PostgreSQL type normalization and SQL generation.
 */

import { describe, test, expect } from "bun:test";
import {
  parseColumnDefinition,
  normalizeDbType,
  typesCompatible,
  buildAddColumnSql,
} from "./migration";

describe("parseColumnDefinition", () => {
  describe("basic type parsing", () => {
    test("parses VARCHAR type", () => {
      const result = parseColumnDefinition("VARCHAR(255)");
      expect(result).not.toBeNull();
      expect(result!.pgType).toBe("VARCHAR");
      expect(result!.nullable).toBe(true);
    });

    test("parses INTEGER type", () => {
      const result = parseColumnDefinition("INTEGER");
      expect(result).not.toBeNull();
      expect(result!.pgType).toBe("INTEGER");
    });

    test("parses INT alias as INTEGER", () => {
      const result = parseColumnDefinition("INT");
      expect(result).not.toBeNull();
      expect(result!.pgType).toBe("INTEGER");
    });

    test("parses BIGINT type", () => {
      const result = parseColumnDefinition("BIGINT");
      expect(result).not.toBeNull();
      expect(result!.pgType).toBe("BIGINT");
    });

    test("parses SERIAL as INTEGER", () => {
      const result = parseColumnDefinition("SERIAL");
      expect(result).not.toBeNull();
      expect(result!.pgType).toBe("INTEGER");
    });

    test("parses BIGSERIAL as BIGINT", () => {
      const result = parseColumnDefinition("BIGSERIAL");
      expect(result).not.toBeNull();
      expect(result!.pgType).toBe("BIGINT");
    });

    test("parses TEXT type", () => {
      const result = parseColumnDefinition("TEXT");
      expect(result).not.toBeNull();
      expect(result!.pgType).toBe("TEXT");
    });

    test("parses BOOLEAN type", () => {
      const result = parseColumnDefinition("BOOLEAN");
      expect(result).not.toBeNull();
      expect(result!.pgType).toBe("BOOLEAN");
    });

    test("parses UUID type", () => {
      const result = parseColumnDefinition("UUID");
      expect(result).not.toBeNull();
      expect(result!.pgType).toBe("UUID");
    });

    test("parses JSONB type", () => {
      const result = parseColumnDefinition("JSONB");
      expect(result).not.toBeNull();
      expect(result!.pgType).toBe("JSONB");
    });

    test("parses TIMESTAMP type", () => {
      const result = parseColumnDefinition("TIMESTAMP");
      expect(result).not.toBeNull();
      expect(result!.pgType).toBe("TIMESTAMP");
    });

    test("parses TIMESTAMPTZ as TIMESTAMP", () => {
      const result = parseColumnDefinition("TIMESTAMPTZ");
      expect(result).not.toBeNull();
      expect(result!.pgType).toBe("TIMESTAMP");
    });
  });

  describe("NUMERIC/DECIMAL parsing", () => {
    test("parses NUMERIC as NUMERIC", () => {
      const result = parseColumnDefinition("NUMERIC(15,4)");
      expect(result).not.toBeNull();
      expect(result!.pgType).toBe("NUMERIC");
    });

    test("parses DECIMAL as NUMERIC", () => {
      const result = parseColumnDefinition("DECIMAL(10,2)");
      expect(result).not.toBeNull();
      expect(result!.pgType).toBe("NUMERIC");
    });

    test("parses NUMERIC without precision", () => {
      const result = parseColumnDefinition("NUMERIC");
      expect(result).not.toBeNull();
      expect(result!.pgType).toBe("NUMERIC");
    });
  });

  describe("FLOAT type parsing", () => {
    test("parses REAL as FLOAT", () => {
      const result = parseColumnDefinition("REAL");
      expect(result).not.toBeNull();
      expect(result!.pgType).toBe("FLOAT");
    });

    test("parses FLOAT as FLOAT", () => {
      const result = parseColumnDefinition("FLOAT");
      expect(result).not.toBeNull();
      expect(result!.pgType).toBe("FLOAT");
    });

    test("parses FLOAT4 as FLOAT", () => {
      const result = parseColumnDefinition("FLOAT4");
      expect(result).not.toBeNull();
      expect(result!.pgType).toBe("FLOAT");
    });

    test("parses FLOAT8 as FLOAT", () => {
      const result = parseColumnDefinition("FLOAT8");
      expect(result).not.toBeNull();
      expect(result!.pgType).toBe("FLOAT");
    });

    test("parses DOUBLE PRECISION as FLOAT", () => {
      const result = parseColumnDefinition("DOUBLE PRECISION");
      expect(result).not.toBeNull();
      expect(result!.pgType).toBe("FLOAT");
    });
  });

  describe("nullable constraints", () => {
    test("column is nullable by default", () => {
      const result = parseColumnDefinition("INTEGER");
      expect(result).not.toBeNull();
      expect(result!.nullable).toBe(true);
    });

    test("parses NOT NULL constraint", () => {
      const result = parseColumnDefinition("INTEGER NOT NULL");
      expect(result).not.toBeNull();
      expect(result!.nullable).toBe(false);
    });

    test("parses NOT NULL with other constraints", () => {
      const result = parseColumnDefinition("VARCHAR(255) NOT NULL UNIQUE");
      expect(result).not.toBeNull();
      expect(result!.nullable).toBe(false);
    });
  });

  describe("default values", () => {
    test("detects DEFAULT clause", () => {
      const result = parseColumnDefinition("INTEGER DEFAULT 0");
      expect(result).not.toBeNull();
      expect(result!.hasDefault).toBe(true);
      expect(result!.defaultValue).toBe("0");
    });

    test("parses string default", () => {
      const result = parseColumnDefinition("VARCHAR(255) DEFAULT 'unknown'");
      expect(result).not.toBeNull();
      expect(result!.hasDefault).toBe(true);
      expect(result!.defaultValue).toBe("'unknown'");
    });

    test("parses function default", () => {
      const result = parseColumnDefinition("UUID DEFAULT gen_random_uuid()");
      expect(result).not.toBeNull();
      expect(result!.hasDefault).toBe(true);
      expect(result!.defaultValue).toBe("gen_random_uuid()");
    });

    test("parses CURRENT_TIMESTAMP default", () => {
      const result = parseColumnDefinition("TIMESTAMP DEFAULT CURRENT_TIMESTAMP");
      expect(result).not.toBeNull();
      expect(result!.hasDefault).toBe(true);
      expect(result!.defaultValue).toBe("CURRENT_TIMESTAMP");
    });

    test("no default when not specified", () => {
      const result = parseColumnDefinition("INTEGER NOT NULL");
      expect(result).not.toBeNull();
      expect(result!.hasDefault).toBe(false);
      expect(result!.defaultValue).toBeNull();
    });
  });

  describe("edge cases", () => {
    test("handles lowercase input", () => {
      const result = parseColumnDefinition("varchar(100) not null");
      expect(result).not.toBeNull();
      expect(result!.pgType).toBe("VARCHAR");
      expect(result!.nullable).toBe(false);
    });

    test("handles mixed case input", () => {
      const result = parseColumnDefinition("VarChar(50) Not Null");
      expect(result).not.toBeNull();
      expect(result!.pgType).toBe("VARCHAR");
      expect(result!.nullable).toBe(false);
    });

    test("handles whitespace", () => {
      const result = parseColumnDefinition("  INTEGER   NOT NULL  ");
      expect(result).not.toBeNull();
      expect(result!.pgType).toBe("INTEGER");
      expect(result!.nullable).toBe(false);
    });
  });
});

describe("normalizeDbType", () => {
  describe("character types", () => {
    test("normalizes character varying to VARCHAR", () => {
      expect(normalizeDbType("character varying", "varchar")).toBe("VARCHAR");
    });

    test("normalizes character to CHAR", () => {
      expect(normalizeDbType("character", "bpchar")).toBe("CHAR");
    });

    test("normalizes TEXT", () => {
      expect(normalizeDbType("text", "text")).toBe("TEXT");
    });
  });

  describe("numeric types", () => {
    test("normalizes INTEGER", () => {
      expect(normalizeDbType("integer", "int4")).toBe("INTEGER");
    });

    test("normalizes BIGINT", () => {
      expect(normalizeDbType("bigint", "int8")).toBe("BIGINT");
    });

    test("normalizes SMALLINT", () => {
      expect(normalizeDbType("smallint", "int2")).toBe("SMALLINT");
    });

    test("normalizes NUMERIC", () => {
      expect(normalizeDbType("numeric", "numeric")).toBe("NUMERIC");
    });

    test("normalizes DECIMAL as NUMERIC", () => {
      expect(normalizeDbType("decimal", "numeric")).toBe("NUMERIC");
    });

    test("normalizes REAL as FLOAT", () => {
      expect(normalizeDbType("real", "float4")).toBe("FLOAT");
    });

    test("normalizes DOUBLE PRECISION as FLOAT", () => {
      expect(normalizeDbType("double precision", "float8")).toBe("FLOAT");
    });
  });

  describe("boolean type", () => {
    test("normalizes BOOLEAN", () => {
      expect(normalizeDbType("boolean", "bool")).toBe("BOOLEAN");
    });
  });

  describe("timestamp types", () => {
    test("normalizes timestamp without time zone", () => {
      expect(normalizeDbType("timestamp without time zone", "timestamp")).toBe("TIMESTAMP");
    });

    test("normalizes timestamp with time zone", () => {
      expect(normalizeDbType("timestamp with time zone", "timestamptz")).toBe("TIMESTAMP");
    });
  });

  describe("JSON types", () => {
    test("normalizes JSONB", () => {
      expect(normalizeDbType("jsonb", "jsonb")).toBe("JSONB");
    });

    test("normalizes JSON", () => {
      expect(normalizeDbType("json", "json")).toBe("JSON");
    });

    test("normalizes user-defined JSONB", () => {
      expect(normalizeDbType("USER-DEFINED", "jsonb")).toBe("JSONB");
    });
  });

  describe("special types", () => {
    test("normalizes UUID", () => {
      expect(normalizeDbType("uuid", "uuid")).toBe("UUID");
    });

    test("normalizes TSVECTOR", () => {
      expect(normalizeDbType("USER-DEFINED", "tsvector")).toBe("TSVECTOR");
    });
  });
});

describe("typesCompatible", () => {
  describe("exact matches", () => {
    test("INTEGER equals INTEGER", () => {
      expect(typesCompatible("INTEGER", "INTEGER")).toBe(true);
    });

    test("VARCHAR equals VARCHAR", () => {
      expect(typesCompatible("VARCHAR", "VARCHAR")).toBe(true);
    });

    test("JSONB equals JSONB", () => {
      expect(typesCompatible("JSONB", "JSONB")).toBe(true);
    });
  });

  describe("compatible variations", () => {
    test("VARCHAR is compatible with TEXT", () => {
      expect(typesCompatible("VARCHAR", "TEXT")).toBe(true);
    });

    test("TEXT is compatible with VARCHAR", () => {
      expect(typesCompatible("TEXT", "VARCHAR")).toBe(true);
    });

    test("JSON is compatible with JSONB", () => {
      expect(typesCompatible("JSON", "JSONB")).toBe(true);
    });

    test("JSONB is compatible with JSON", () => {
      expect(typesCompatible("JSONB", "JSON")).toBe(true);
    });

    test("INTEGER is compatible with INT4", () => {
      expect(typesCompatible("INTEGER", "INT4")).toBe(true);
    });

    test("FLOAT is compatible with FLOAT8", () => {
      expect(typesCompatible("FLOAT", "FLOAT8")).toBe(true);
    });
  });

  describe("incompatible types", () => {
    test("INTEGER is not compatible with VARCHAR", () => {
      expect(typesCompatible("INTEGER", "VARCHAR")).toBe(false);
    });

    test("BOOLEAN is not compatible with INTEGER", () => {
      expect(typesCompatible("BOOLEAN", "INTEGER")).toBe(false);
    });

    test("UUID is not compatible with TEXT", () => {
      expect(typesCompatible("UUID", "TEXT")).toBe(false);
    });

    test("TIMESTAMP is not compatible with INTEGER", () => {
      expect(typesCompatible("TIMESTAMP", "INTEGER")).toBe(false);
    });
  });
});

describe("buildAddColumnSql", () => {
  describe("basic column addition", () => {
    test("generates simple ADD COLUMN", () => {
      const sql = buildAddColumnSql("users", "email", "VARCHAR(255)");
      expect(sql).toBe("ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255)");
    });

    test("generates ADD COLUMN with NOT NULL and explicit default", () => {
      const sql = buildAddColumnSql("users", "active", "BOOLEAN NOT NULL DEFAULT TRUE");
      expect(sql).toBe("ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE");
    });
  });

  describe("auto-default for NOT NULL columns", () => {
    test("adds default for BOOLEAN NOT NULL", () => {
      const sql = buildAddColumnSql("users", "active", "BOOLEAN NOT NULL");
      expect(sql).toContain("DEFAULT FALSE");
      expect(sql).toContain("NOT NULL");
    });

    test("adds default for INTEGER NOT NULL", () => {
      const sql = buildAddColumnSql("users", "count", "INTEGER NOT NULL");
      expect(sql).toContain("DEFAULT 0");
      expect(sql).toContain("NOT NULL");
    });

    test("adds default for BIGINT NOT NULL", () => {
      const sql = buildAddColumnSql("users", "big_count", "BIGINT NOT NULL");
      expect(sql).toContain("DEFAULT 0");
    });

    test("adds default for UUID NOT NULL", () => {
      const sql = buildAddColumnSql("users", "id", "UUID NOT NULL");
      expect(sql).toContain("DEFAULT gen_random_uuid()");
    });

    test("adds default for TIMESTAMP NOT NULL", () => {
      const sql = buildAddColumnSql("users", "created", "TIMESTAMP NOT NULL");
      expect(sql).toContain("DEFAULT CURRENT_TIMESTAMP");
    });

    test("adds default for JSONB NOT NULL", () => {
      const sql = buildAddColumnSql("users", "metadata", "JSONB NOT NULL");
      expect(sql).toContain("DEFAULT '{}'::jsonb");
    });

    test("adds default for TEXT NOT NULL", () => {
      const sql = buildAddColumnSql("users", "name", "TEXT NOT NULL");
      expect(sql).toContain("DEFAULT ''");
    });

    test("adds default for VARCHAR NOT NULL", () => {
      const sql = buildAddColumnSql("users", "name", "VARCHAR(100) NOT NULL");
      expect(sql).toContain("DEFAULT ''");
    });
  });

  describe("PRIMARY KEY handling", () => {
    test("removes PRIMARY KEY from definition", () => {
      const sql = buildAddColumnSql("users", "id", "INTEGER PRIMARY KEY");
      expect(sql).not.toContain("PRIMARY KEY");
      expect(sql).toContain("INTEGER");
    });
  });

  describe("nullable columns", () => {
    test("does not add default for nullable columns", () => {
      const sql = buildAddColumnSql("users", "nickname", "VARCHAR(100)");
      expect(sql).not.toContain("DEFAULT");
      expect(sql).toBe("ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname VARCHAR(100)");
    });
  });
});
