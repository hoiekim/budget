import { useEffect } from "react";
import { useAppContext, useSync, PATH } from "client";

/**
 * This component is used to run useEffect hooks dependant on context variables.
 * It is recommended to use this component for all globally affecting hooks for
 * dev engineers to find them easily.
 */
const Utility = () => {
  const { user, router, setSelectedInterval, data, calculate, viewDate } = useAppContext();

  const userLoggedIn = !!user;
  const { path, go } = router;

  const { sync, clean } = useSync();

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
   * Calculate balance history when data is updated
   */
  useEffect(() => {
    if (!data.status.isInit) return;
    calculate(data);
  }, [data, calculate]);

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
