import {
  Route,
  createRecurring,
  addToRecurring,
  confirmRecurring,
  normalizeMerchantName,
  transactionsTable,
  USER_ID,
  TRANSACTION_ID,
  requireBodyObject,
  validationError,
} from "server";
import type { RecurringCadence } from "common";

const CADENCE_BY_DAYS: { maxDays: number; cadence: RecurringCadence }[] = [
  { maxDays: 10, cadence: "weekly" },
  { maxDays: 21, cadence: "biweekly" },
  { maxDays: 45, cadence: "monthly" },
  { maxDays: 120, cadence: "quarterly" },
  { maxDays: 270, cadence: "semiannual" },
  { maxDays: Infinity, cadence: "annual" },
];

export const postRecurringRoute = new Route("POST", "/recurrings", async (req) => {
  const { user } = req.session;
  if (!user) {
    return { status: "failed", message: "Request user is not authenticated." };
  }

  const bodyResult = requireBodyObject(req);
  if (!bodyResult.success) return validationError(bodyResult.error!);

  const body = bodyResult.data as Record<string, unknown>;

  // If recurring_id is provided with transaction_ids, add those
  // transactions to the existing recurring (the detail page's "add to
  // recurring" affordance). With recurring_id alone, confirm a suggested
  // recurring.
  if (typeof body.recurring_id === "string") {
    if (Array.isArray(body.transaction_ids)) {
      const transactionIds = body.transaction_ids.filter(
        (id): id is string => typeof id === "string",
      );
      const result = await addToRecurring(user, body.recurring_id, transactionIds);
      if (!result.ok) return { status: "failed", message: result.error };
      return { status: "success", body: { recurring_id: body.recurring_id } };
    }
    const result = await confirmRecurring(user, body.recurring_id);
    if (!result.ok) return { status: "failed", message: result.error };
    return { status: "success", body: { recurring_id: body.recurring_id } };
  }

  // Otherwise create a new recurring from explicit transaction ids (the
  // "mark as recurring" affordance). Manual creation is user intent, not a
  // suggestion — the members just have to agree on one merchant group and
  // one direction; the cadence is estimated from the median interval
  // without the detection pass's tolerance gate.
  if (!Array.isArray(body.transaction_ids)) {
    return validationError(
      "transaction_ids must be an array of transaction ids",
    );
  }
  const transactionIds = body.transaction_ids.filter(
    (id): id is string => typeof id === "string",
  );
  if (transactionIds.length < 1) {
    return validationError("at least one transaction is required");
  }

  const txnModels = await transactionsTable.query(
    { [USER_ID]: user.user_id },
    { inFilters: { [TRANSACTION_ID]: transactionIds } },
  );
  const txns = txnModels
    .map((m) => m.toJSON())
    .filter((t) => !t.is_deleted && !t.pending && t.amount !== 0);
  if (txns.length !== transactionIds.length) {
    return {
      status: "failed",
      message:
        "One or more transactions no longer exist (deleted or never belonged to this user).",
    };
  }

  const keys = txns.map((t) =>
    normalizeMerchantName(t.merchant_name || t.name || ""),
  );
  const directions = txns.map((t) => t.amount < 0);
  const merchant_key = keys[0]!;
  const is_income = directions[0]!;
  if (
    !merchant_key ||
    !keys.every((k) => k === merchant_key) ||
    !directions.every((d) => d === is_income)
  ) {
    return {
      status: "failed",
      message:
        "Those transactions don't form a single recurring group (same merchant and direction).",
    };
  }

  const dates = txns.map((t) => t.date.slice(0, 10)).sort();
  const intervals: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    intervals.push(
      Math.round(
        (new Date(dates[i]! + "T00:00:00").getTime() -
          new Date(dates[i - 1]! + "T00:00:00").getTime()) /
          86_400_000,
      ),
    );
  }
  // A single transaction has no interval to measure — default to
  // monthly; the cadence is informational and the detection job's
  // auto-attach matches on merchant_key + direction regardless.
  let cadence: RecurringCadence = "monthly";
  if (intervals.length > 0) {
    intervals.sort((a, b) => a - b);
    const medianInterval = intervals[Math.floor(intervals.length / 2)]!;
    cadence = CADENCE_BY_DAYS.find((c) => medianInterval <= c.maxDays)!.cadence;
  }

  // A caller-supplied name wins (the detail page's "name this
  // recurring" input); otherwise fall back to the most common
  // merchant_name among the members.
  const customName =
    typeof body.merchant_name === "string" && body.merchant_name.trim()
      ? body.merchant_name.trim()
      : null;
  const nameCounts = new Map<string, number>();
  let merchant_name = customName ?? txns[0]!.merchant_name ?? txns[0]!.name;
  let best = 0;
  for (const t of txns) {
    const n = t.merchant_name || t.name;
    const count = (nameCounts.get(n) || 0) + 1;
    nameCounts.set(n, count);
    if (count > best) {
      best = count;
      merchant_name = n;
    }
  }

  const result = await createRecurring(user, {
    transaction_ids: transactionIds,
    merchant_key,
    merchant_name,
    cadence,
    is_income,
  });
  if (!result.ok) return { status: "failed", message: result.error };

  return { status: "success", body: { recurring_id: result.recurring_id } };
});
