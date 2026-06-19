import { useEffect, useMemo } from "react";
import { useAppContext, useSync, PATH, useDebounce } from "client";

/**
 * This component is used to run useEffect hooks dependant on context variables.
 * It is recommended to use this component for all globally affecting hooks for
 * dev engineers to find them easily.
 */
const Utility = () => {
  const { user, router, setSelectedInterval, data, calculate, viewDate, transfers } =
    useAppContext();

  const userLoggedIn = !!user;
  const { path, go } = router;

  const { sync, clean } = useSync();
  const debouncer = useDebounce();

  /**
   * Redirect to login page if not logged in
   */
  useEffect(() => {
    const { LOGIN } = PATH;
    if (!user && path !== LOGIN) go(LOGIN);
  }, [user, go, path]);

  /**
   * Download data when user logs in and remove data when user logs out
   */
  useEffect(() => {
    if (userLoggedIn) sync();
    else clean();
  }, [userLoggedIn, sync, clean]);

  // Confirmed-transfer transaction id set, derived once per
  // `transfers.confirmedTransferByTransactionId` ref change. Threaded
  // into `calculate(...)` so `getBudgetData` (and any future calc
  // wanting to skip transfers) sees the latest pair set. Per-account
  // balance calc intentionally does not consume this — see
  // `useData`'s `calculateAll` comment.
  const confirmedTransferTxIds = useMemo(() => {
    const set = new Set<string>();
    transfers.confirmedTransferByTransactionId.forEach((_pair, txId) => set.add(txId));
    return set;
  }, [transfers.confirmedTransferByTransactionId]);

  /**
   * Calculate balance history when data is updated
   */
  useEffect(() => {
    if (!data.status.isInit) return;
    debouncer(() => calculate(data, { confirmedTransferTxIds }));
  }, [data, calculate, debouncer, confirmedTransferTxIds]);

  /**
   * Update viewDate when user selects different interval
   */
  useEffect(() => {
    setSelectedInterval(viewDate.getInterval());
  }, [viewDate, setSelectedInterval]);

  /**
   * This prevents draggable element's ghost image flying back
   * to original position.
   */
  useEffect(() => {
    const handler = (e: DragEvent) => e.preventDefault();
    window.document.addEventListener("dragover", handler);
    return () => window.document.removeEventListener("dragover", handler);
  }, []);

  return <></>;
};

export default Utility;
