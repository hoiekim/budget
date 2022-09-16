import { useEffect } from "react";
import { useAppContext, useSync } from "client";

let lastSync = new Date();

const Utility = () => {
  const {
    user,
    router,
    setCategories,
    budgets,
    selectedBudgetId,
    selectedInterval,
    transactions,
    accounts,
    viewDate,
    setViewDate,
  } = useAppContext();
  const { path, go } = router;

  useEffect(() => {
    if (!user && path !== "/login") go("/login");
  }, [user, go, path]);

  const { sync, clean } = useSync();

  const userLoggedIn = !!user;

  useEffect(() => {
    if (userLoggedIn) sync.all();
    else clean();
  }, [userLoggedIn, sync, clean]);

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

  useEffect(() => {
    const budget = budgets.get(selectedBudgetId);
    if (!budget) return;

    const viewDateClone = viewDate.clone();

    setCategories((oldCategories) => {
      const newCategories = new Map(oldCategories);
      newCategories.forEach((e) => {
        e.amount = 0;
      });
      transactions.forEach((e) => {
        const transactionDate = new Date(e.authorized_date || e.date);
        if (!viewDateClone.has(transactionDate)) return;
        const account = accounts.get(e.account_id);
        if (account?.hide) return;
        const { category_id } = e.label;
        if (!category_id) return;
        const newCategory = newCategories.get(category_id);
        if (!newCategory) return;
        (newCategory.amount as number) += Math.max(e.amount, 0);
        newCategories.set(category_id, newCategory);
      });
      return newCategories;
    });
  }, [
    transactions,
    accounts,
    setCategories,
    budgets,
    selectedBudgetId,
    selectedInterval,
    viewDate,
  ]);

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
