import { useEffect } from "react";
import { useAppContext, useSync, PATH } from "client";

let lastSync = new Date();

const Utility = () => {
  const {
    user,
    router,
    setBudgets,
    setSections,
    setCategories,
    budgets,
    selectedBudgetId,
    setSelectedBudgetId,
    selectedInterval,
    transactions,
    accounts,
    viewDate,
    setViewDate,
  } = useAppContext();
  const { path, go } = router;

  useEffect(() => {
    const { LOGIN } = PATH;
    if (!user && path !== LOGIN) go(LOGIN);
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

      setSections((oldSections) => {
        const newSections = new Map(oldSections);

        newSections.forEach((e) => {
          e.amount = 0;
        });

        newCategories.forEach((e) => {
          if (!e.amount) return;
          const parentSection = newSections.get(e.section_id);
          if (parentSection?.amount === undefined) return;
          parentSection.amount += e.amount || 0;
        });

        setBudgets((oldBudgets) => {
          const newBudgets = new Map(oldBudgets);

          newBudgets.forEach((e) => {
            e.amount = 0;
          });

          newSections.forEach((e) => {
            if (!e.amount) return;
            const parentBudget = newBudgets.get(e.budget_id);
            if (parentBudget?.amount === undefined) return;
            parentBudget.amount += e.amount || 0;
          });

          return newBudgets;
        });

        return newSections;
      });

      return newCategories;
    });
  }, [transactions, accounts, setBudgets, setSections, setCategories, viewDate]);

  useEffect(() => {
    setViewDate((oldViewDate) => {
      const newViewDate = oldViewDate.clone();
      newViewDate.setInterval(selectedInterval);
      return newViewDate;
    });
  }, [selectedInterval, setViewDate]);

  useEffect(() => {
    if (!selectedBudgetId && budgets.size) {
      setSelectedBudgetId(budgets.values().next().value);
    }
  }, [selectedBudgetId, setSelectedBudgetId, budgets]);

  return <></>;
};

export default Utility;
