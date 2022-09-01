import { useEffect } from "react";
import { IsDate, useAppContext, useSync } from "client";

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

    const isViewDate = new IsDate(viewDate);

    setCategories((oldCategories) => {
      const newCategories = new Map(oldCategories);
      newCategories.forEach((e) => {
        e.amount = 0;
      });
      transactions.forEach((e) => {
        const transactionDate = new Date(e.authorized_date || e.date);
        if (!isViewDate.within(selectedInterval).from(transactionDate)) return;
        const account = accounts.get(e.account_id);
        if (account?.hide) return;
        const { category_id } = e.label;
        if (!category_id) return;
        const newCategory = newCategories.get(category_id);
        if (!newCategory) return;
        (newCategory.amount as number) += e.amount;
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

  return <></>;
};

export default Utility;
