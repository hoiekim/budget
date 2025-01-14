import { useEffect } from "react";
import { useAppContext, useDebounce, useSync, useCalculator, PATH } from "client";

/**
 * This component is used to run useEffect hooks dependant on context variables.
 * It is recommended to use this component for all globally affecting hooks for
 * dev engineers to find them easily.
 */
const Utility = () => {
  const { user, router, setSelectedInterval, data, viewDate } = useAppContext();
  const { transactions, accounts } = data;

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

  const calculationDebouncer = useDebounce();

  /**
   * Calculate transactions amounts when data is updated
   */
  useEffect(() => {
    calculationDebouncer(calculate);
  }, [transactions, accounts, viewDate, calculate, calculationDebouncer]);

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
    window.document.ondragover = (e) => e.preventDefault();
  }, []);

  return <></>;
};

export default Utility;
