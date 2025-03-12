import { Account, Chart, Holding, JSONChart, Security } from "common";
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
  PartialSnapshotData,
} from "server";

export const getUpdateScriptWithUser = ({ user_id }: MaskedUser, type: string, data: any) => {
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

export const getUpdateScript = (type: string, data: any) => {
  const source = `
if (ctx._source.type == "${type}") {
  ${Object.keys(flatten(data)).reduce((acc, key) => {
    if (key === `${type}_id`) return acc;
    return acc + `ctx._source.${type}.${key} = params.${key};\n`;
  }, "")}
} else {
  throw new Exception("Found document is not ${type} type.");
}
`;
  return { source, lang: "painless", params: data };
};

export const getUpdateTransactionScript = (user: MaskedUser, transaction: PartialTransaction) => {
  return getUpdateScriptWithUser(user, "transaction", transaction);
};

export const getUpdateInvestmentTransactionScript = (
  user: MaskedUser,
  investmentTransaction: PartialInvestmentTransaction
) => {
  return getUpdateScriptWithUser(user, "investment_transaction", investmentTransaction);
};

export const getUpdateSplitTransactionScript = (
  user: MaskedUser,
  splitTransaction: PartialSplitTransaction
) => {
  return getUpdateScriptWithUser(user, "split_transaction", splitTransaction);
};

export const getUpdateAccountScript = (user: MaskedUser, account: PartialAccount) => {
  return getUpdateScriptWithUser(user, "account", account);
};

export const getUpdateHoldingScript = (user: MaskedUser, holding: PartialHolding) => {
  return getUpdateScriptWithUser(user, "holding", holding);
};

export const getUpdateSecurityScript = (security: PartialSecurity) => {
  return getUpdateScript("security", security);
};

export const getUpdateInstitutionScript = (institution: PartialInstitution) => {
  return getUpdateScript("institution", institution);
};

export const getUpdateBudgetScript = (user: MaskedUser, budget: PartialBudget) => {
  return getUpdateScriptWithUser(user, "budget", budget);
};

export const getUpdateSectionScript = (user: MaskedUser, section: PartialSection) => {
  return getUpdateScriptWithUser(user, "section", section);
};

export const getUpdateCategoryScript = (user: MaskedUser, category: PartialCategory) => {
  return getUpdateScriptWithUser(user, "category", category);
};

export const getUpdateItemScript = (user: MaskedUser, item: Omit<PartialItem, "plaidError">) => {
  return getUpdateScriptWithUser(user, "item", item);
};

export const getUpdateChartScript = (user: MaskedUser, chart: Partial<JSONChart>) => {
  return getUpdateScriptWithUser(user, "chart", chart);
};

export const getUpdateSnapshotScript = (snapshot: PartialSnapshotData) => {
  let type: "account" | "holding" | "security";
  let data: Partial<Account> | Partial<Holding> | Partial<Security>;
  let user_id: string | undefined = undefined;
  if ("account" in snapshot) {
    type = "account";
    data = snapshot.account;
    user_id = snapshot.user.user_id;
  } else if ("holding" in snapshot) {
    type = "holding";
    data = snapshot.holding;
    user_id = snapshot.user.user_id;
  } else if ("security" in snapshot) {
    type = "security";
    data = snapshot.security;
  } else return undefined;

  let source = `
  if (ctx._source.type == "snapshot") {
    ${Object.keys(flatten(data)).reduce((acc, key) => {
      if (key === `${type}_id`) return acc;
      return acc + `ctx._source.${type}.${key} = params.${key};\n`;
    }, "")}
  } else {
    throw new Exception("Found document is not snapshot type.");
  }
`;

  if (user_id) {
    source = `
if (ctx._source.user.user_id == "${user_id}") {
${source}
  } else {
    throw new Exception("Request user doesn't have permission for this document.");
}
`;
  }

  return { source, lang: "painless", params: data };
};
