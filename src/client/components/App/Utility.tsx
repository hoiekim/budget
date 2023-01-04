import { useEffect } from "react";
import { useAppContext, useSync, PATH } from "client";

let lastSync = new Date();

/**
 * This component is used to run useEffect hooks dependant on context variables.
 * It is recommended to use this component for all globally affecting hooks for
 * dev engineers to find them easily.
 */
const Utility = () => {
  const {
    user,
    router,
    setBudgets,
    setSections,
    setCategories,
    selectedInterval,
    transactions,
    accounts,
    viewDate,
    setViewDate,
  } = useAppContext();
  const { path, go } = router;

  /**
   * Redirect to login page if not logged in
   */
  useEffect(() => {
    const { LOGIN } = PATH;
    if (!user && path !== LOGIN) go(LOGIN);
  }, [user, go, path]);

  const { sync, clean } = useSync();

  const userLoggedIn = !!user;

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
    const viewDateClone = viewDate.clone();

    setCategories((oldCategories) => {
      const newCategories = new Map(oldCategories);

      newCategories.forEach((e) => {
        e.sorted_amount = 0;
      });

      const unsortedAmountByBudget: { [k: string]: number } = {};

      transactions.forEach((e) => {
        const transactionDate = new Date(e.authorized_date || e.date);
        if (!viewDateClone.has(transactionDate)) return;
        const account = accounts.get(e.account_id);
        if (!account || account.hide) return;
        const { budget_id, category_id } = e.label;
        if (!category_id) {
          const budgetId = budget_id || account.label.budget_id;
          if (budgetId) {
            if (!unsortedAmountByBudget[budgetId]) unsortedAmountByBudget[budgetId] = 0;
            unsortedAmountByBudget[budgetId] += e.amount;
          }
          return;
        }
        const newCategory = newCategories.get(category_id);
        if (!newCategory || newCategory.sorted_amount === undefined) return;
        newCategory.sorted_amount += e.amount;
        newCategories.set(category_id, newCategory);
      });

      setSections((oldSections) => {
        const newSections = new Map(oldSections);

        newSections.forEach((e) => {
          e.sorted_amount = 0;
        });

        newCategories.forEach((e) => {
          if (!e.sorted_amount) return;
          const parentSection = newSections.get(e.section_id);
          if (parentSection?.sorted_amount === undefined) return;
          parentSection.sorted_amount += e.sorted_amount || 0;
        });

        setBudgets((oldBudgets) => {
          const newBudgets = new Map(oldBudgets);

          newBudgets.forEach((e) => {
            e.sorted_amount = 0;
            e.unsorted_amount = unsortedAmountByBudget[e.budget_id] || 0;
          });

          newSections.forEach((e) => {
            if (!e.sorted_amount) return;
            const parentBudget = newBudgets.get(e.budget_id);
            if (parentBudget?.sorted_amount === undefined) return;
            parentBudget.sorted_amount += e.sorted_amount || 0;
          });

          return newBudgets;
        });

        return newSections;
      });

      return newCategories;
    });
  }, [transactions, accounts, setBudgets, setSections, setCategories, viewDate]);

  /**
   * Update viewDate when user selects different interval
   */
  useEffect(() => {
    setViewDate((oldViewDate) => {
      const newViewDate = oldViewDate.clone();
      newViewDate.setInterval(selectedInterval);
      return newViewDate;
    });
  }, [selectedInterval, setViewDate]);

  return <></>;
};

export default Utility;
