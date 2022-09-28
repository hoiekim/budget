import {
  deepFlatten,
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
} from "server";

export const getUpdateScript = ({ user_id }: MaskedUser, type: string, data: any) => `
if (ctx._source.user.user_id == "${user_id}") {
  if (ctx._source.type == "${type}") {
    ${Object.entries(deepFlatten(data)).reduce((acc, [key, value]) => {
      if (key === `${type}_id`) return acc;
      return acc + `ctx._source.${type}.${key} = ${JSON.stringify(value)};\n`;
    }, "")}
  } else {
    throw new Exception("Found document is not ${type} type.");
  }
} else {
  throw new Exception("Request user doesn't have permission for this document.");
}
`;

export const getUpdateTransactionScript = (
  user: MaskedUser,
  transaction: PartialTransaction
) => {
  return getUpdateScript(user, "transaction", transaction);
};

export const getUpdateInvestmentTransactionScript = (
  user: MaskedUser,
  investmentTransaction: PartialInvestmentTransaction
) => {
  return getUpdateScript(user, "investment_transaction", investmentTransaction);
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

export const getUpdateBudgetScript = (user: MaskedUser, budget: PartialBudget) => {
  return getUpdateScript(user, "budget", budget);
};

export const getUpdateSectionScript = (user: MaskedUser, section: PartialSection) => {
  return getUpdateScript(user, "section", section);
};

export const getUpdateCategoryScript = (user: MaskedUser, category: PartialCategory) => {
  return getUpdateScript(user, "category", category);
};

export const getUpdateItemScript = (
  user: MaskedUser,
  item: Omit<PartialItem, "plaidError">
) => {
  return getUpdateScript(user, "item", item);
};
