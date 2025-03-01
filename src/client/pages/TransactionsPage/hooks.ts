import { useAppContext } from "client";
import { getHitScore, InvestmentTransaction, SplitTransaction, Transaction } from "common";
import { useCallback } from "react";

export const useTransactionHit = () => {
  const { data } = useAppContext();
  const { budgets, sections, categories, accounts, institutions } = data;
  const hit = useCallback(
    (searchValue: string, transaction: Transaction | InvestmentTransaction | SplitTransaction) => {
      if (!searchValue) return 0;
      let searchPool: string[] = [];
      if (transaction instanceof Transaction) {
        const { name, merchant_name, account_id, label } = transaction;
        if (name) searchPool.push(name);
        if (merchant_name) searchPool.push(merchant_name);

        const account = accounts.get(account_id);
        if (account) {
          const { name, custom_name } = account;
          if (custom_name) searchPool.push(custom_name);
          else if (name) searchPool.push(name);
        }

        const institution_id = account?.institution_id;
        const institution = institution_id && institutions.get(institution_id);
        if (institution) searchPool.push(institution.name);

        const accountBudgetId = account?.label.budget_id;
        const { budget_id = accountBudgetId, category_id } = label;
        const budget = budget_id && budgets.get(budget_id);
        const category = category_id && categories.get(category_id);
        const section_id = category && category.section_id;
        const section = section_id && sections.get(section_id);

        if (budget) searchPool.push(budget.name);
        if (section) searchPool.push(section.name);
        if (category) searchPool.push(category.name);
      }

      const search = searchValue.toLowerCase();
      const searchWords = search.split(" ");
      const totalScore = searchWords.reduce((acc, w) => {
        return acc + getHitScore(w, searchPool.join(" "));
      }, 0);

      return totalScore / searchWords.length;
    },
    [accounts, budgets, sections, categories, institutions]
  );
  return hit;
};
