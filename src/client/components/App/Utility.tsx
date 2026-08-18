import { useEffect } from "react";
import { useAppContext, useSync, useServerEvents, tabId, PATH, useDebounce } from "client";

/**
 * This component is used to run useEffect hooks dependant on context variables.
 * It is recommended to use this component for all globally affecting hooks for
 * dev engineers to find them easily.
 */
const Utility = () => {
  const { user, router, data, calculate } = useAppContext();

  const userLoggedIn = !!user;
  const { path, go } = router;

  const { sync, syncDomain, clean } = useSync();
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

  /**
   * Real-time collaboration: a server-pushed `<table>-updated` event
   * means another tab / another user changed that table — refetch just that
   * domain's slot via `syncDomain(domain)`. Events tagged with this tab's
   * own `tabId` are its own writes (already applied optimistically) and
   * skipped. Per-domain debouncing collapses bursts of the same event; the
   * cursor is not advanced (only the whole-app `sync()` owns that).
   */
  useServerEvents(
    (domain, payload) => {
      if (payload.originTabId === tabId) return;
      syncDomain(domain);
    },
    userLoggedIn,
    sync,
  );

  /**
   * Calculate balance history when data is updated
   */
  useEffect(() => {
    if (!data.status.isInit) return;
    debouncer(() => calculate(data));
  }, [data, calculate, debouncer]);

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
