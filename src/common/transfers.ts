// Constants shared between the server-side transfer-detection engine
// (`server/lib/compute-tools/detect-transfers.ts`) and the FE manual
// "Mark as Transfer" partner-picker (`client/components/TransactionProperties`).
//
// Both must use the SAME window so any partner the engine would have
// suggested is also reachable via the manual picker — otherwise the
// engine produces a suggestion the user can't manually reproduce when
// they reject it and want to re-pair. (Bug reported 2026-06-25: a 2/2
// transaction's engine-suggested partner from late January was outside
// the FE's 3-day window — engine uses 7 — so the manual picker showed
// "no matching transactions" for a pair the engine had just surfaced.)
export const TRANSFER_DATE_WINDOW_DAYS = 7;
