import { useEffect } from "react";
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

  // `transfers.confirmedTransferByTransactionId` is already a
  // Map<transaction_id, ConfirmedTransfer>; its `.has(id)` answers the
  // exact question the calcs ask. Feeding the Map straight through
  // avoids a redundant Set materialization (Hoie review 2026-06-19).
  // Per-account balance calc intentionally does not consume this —
  // see `useData`'s `calculateAll` comment.
  const confirmedTransferIds = transfers.confirmedTransferByTransactionId;

  /**
   * Calculate balance history when data is updated
   */
  useEffect(() => {
    if (!data.status.isInit) return;
    debouncer(() => calculate(data, { confirmedTransferIds }));
  }, [data, calculate, debouncer, confirmedTransferIds]);

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
