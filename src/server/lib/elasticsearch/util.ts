import {
  flatten,
  MaskedUser,
  PartialAccount,
  PartialTransaction,
  PartialBudget,
  PartialSection,
  PartialCategory,
  PartialItem,
  PartialInvestmentTransaction,
  PartialHolding,
  PartialSecurity,
  PartialInstitution,
  PartialSplitTransaction,
} from "server";

export const getUpdateScript = ({ user_id }: MaskedUser, type: string, data: any) => {
  const source = `
if (ctx._source.user.user_id == "${user_id}") {
  if (ctx._source.type == "${type}") {
    ${Object.keys(flatten(data)).reduce((acc, key) => {
      if (key === `${type}_id`) return acc;
      return acc + `ctx._source.${type}.${key} = params.${key};\n`;
    }, "")}
  } else {
    throw new Exception("Found document is not ${type} type.");
  }
} else {
  throw new Exception("Request user doesn't have permission for this document.");
}
`;
  return { source, lang: "painless", params: data };
};

export const getUpdateTransactionScript = (user: MaskedUser, transaction: PartialTransaction) => {
  return getUpdateScript(user, "transaction", transaction);
};

export const getUpdateInvestmentTransactionScript = (
  user: MaskedUser,
  investmentTransaction: PartialInvestmentTransaction
) => {
  return getUpdateScript(user, "investment_transaction", investmentTransaction);
};

export const getUpdateSplitTransactionScript = (
  user: MaskedUser,
  splitTransaction: PartialSplitTransaction
) => {
  return getUpdateScript(user, "split_transaction", splitTransaction);
};

export const getUpdateAccountScript = (user: MaskedUser, account: PartialAccount) => {
  return getUpdateScript(user, "account", account);
};

export const getUpdateHoldingScript = (user: MaskedUser, holding: PartialHolding) => {
  return getUpdateScript(user, "holding", holding);
};

export const getUpdateSecurityScript = (user: MaskedUser, security: PartialSecurity) => {
  return getUpdateScript(user, "security", security);
};

export const getUpdateInstitutionScript = (user: MaskedUser, institution: PartialInstitution) => {
  return getUpdateScript(user, "institution", institution);
};

export const getUpdateBudgetScript = (user: MaskedUser, budget: PartialBudget) => {
  return getUpdateScript(user, "budget", budget);
};

export const getUpdateSectionScript = (user: MaskedUser, section: PartialSection) => {
  return getUpdateScript(user, "section", section);
};

export const getUpdateCategoryScript = (user: MaskedUser, category: PartialCategory) => {
  return getUpdateScript(user, "category", category);
};

export const getUpdateItemScript = (user: MaskedUser, item: Omit<PartialItem, "plaidError">) => {
  return getUpdateScript(user, "item", item);
};
