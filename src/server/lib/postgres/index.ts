/**
 * PostgreSQL Database Module
 *
 * Provides data access layer for the budget application.
 * Uses flattened column structure for partial updates (no JSONB for nested objects
 * except for array fields like capacities).
 *
 * Architecture:
 * - models/: Schema definitions and model classes with validation
 * - repositories/: CRUD operations using models
 * - database.ts: Generic query helpers
 * - client.ts: Connection pool
 * - initialize.ts: Table creation
 */

export * from "./client";
export * from "./initialize";
export * from "./database";
export * from "./models";
export * from "./repositories";
