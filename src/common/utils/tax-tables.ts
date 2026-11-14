import type { FederalIncomeTaxTable, StateIncomeTaxTable } from "./tax";

/** Tax year every table below is for, unless a state's own `taxYear` says otherwise. */
export const TAX_YEAR = 2026;

/** Single filer, IRS Rev. Proc. 2025-32 (2026, as amended by the One Big Beautiful Bill Act). */
export const FEDERAL_INCOME_TAX: FederalIncomeTaxTable = {
  standardDeduction: 16100,
  brackets: [
    [0, 0.1],
    [12400, 0.12],
    [50400, 0.22],
    [105700, 0.24],
    [201775, 0.32],
    [256225, 0.35],
    [640600, 0.37],
  ],
};

// WORK IN PROGRESS: the per-state 2026 single-filer tables are being compiled
// and land in the next commit. Until then every state estimates as federal
// only, and the "cover every state" test in tax.test.ts fails on purpose.
export const STATE_INCOME_TAX: Record<string, StateIncomeTaxTable> = {};
