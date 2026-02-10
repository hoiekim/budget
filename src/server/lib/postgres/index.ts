/**
 * PostgreSQL Database Module
 *
 * Provides data access layer for the budget application.
 * Uses flattened column structure for partial updates (no JSONB for nested objects
 * except for array fields like capacities).
 */

export * from "./client";
export * from "./initialize";
export * from "./users";
export * from "./session";
export * from "./items";
export * from "./accounts";
export * from "./transactions";
export * from "./budgets";
export * from "./snapshots";
export * from "./charts";
export * from "./utils";
