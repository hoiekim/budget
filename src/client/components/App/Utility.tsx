import { useEffect } from "react";
import { useAppContext, useSync, useCalculator, PATH } from "client";

let lastSync = new Date();

/**
 * This component is used to run useEffect hooks dependant on context variables.
 * It is recommended to use this component for all globally affecting hooks for
 * dev engineers to find them easily.
 */
const Utility = () => {
  const { user, router, setSelectedInterval, transactions, accounts, viewDate } =
    useAppContext();

  const userLoggedIn = !!user;
  const { path, go } = router;

  const { sync, clean } = useSync();
  const calculate = useCalculator();

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
    if (userLoggedIn) sync.all();
    else clean();
  }, [userLoggedIn, sync, clean]);

  /**
   * Download data when re-activate the app
   */
  useEffect(() => {
    const focusAction = (event: FocusEvent) => {
      const now = new Date();
      if (now.getTime() - lastSync.getTime() > 1000 * 60) {
        sync.all();
        lastSync = now;
      }
    };
    window.addEventListener("focus", focusAction);
    return () => window.removeEventListener("focus", focusAction);
  }, [sync]);

  /**
   * Calculate transactions amounts when data is updated
   */
  useEffect(() => {
    calculate();
  }, [transactions, accounts, viewDate, calculate]);

  /**
   * Update viewDate when user selects different interval
   */
  useEffect(() => {
    setSelectedInterval(viewDate.getInterval());
  }, [viewDate, setSelectedInterval]);

  return <></>;
};

export default Utility;
