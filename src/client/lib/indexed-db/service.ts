import { JSONSplitTransaction } from "common";
import {
  BalanceData,
  AmountByMonth,
  BalanceHistory,
  BudgetData,
  BudgetSummaryByMonth,
  BudgetHistory,
  TransactionFamilies,
  SplitTransactionDictionary,
  SplitTransaction,
  InstitutionDictionary,
  Institution,
  AccountDictionary,
  Account,
  TransactionDictionary,
  Dictionary,
  Transaction,
  InvestmentTransactionDictionary,
  InvestmentTransaction,
  BudgetDictionary,
  Budget,
  SectionDictionary,
  Section,
  CategoryDictionary,
  Category,
  ItemDictionary,
  Item,
  ChartDictionary,
  Chart,
  AccountSnapshotDictionary,
  AccountSnapshot,
  HoldingSnapshotDictionary,
  HoldingSnapshot,
  SecuritySnapshotDictionary,
  SecuritySnapshot,
  CapacityData,
  CapacitySummary,
  Data,
  Calculations,
} from "client";
import { StoreName, indexedDbAccessor } from "./accessor";

export const saveBalanceData = async (data: BalanceData) => {
  const entries = data.getEntries();
  await indexedDbAccessor.saveMany(StoreName.balanceData, entries);
};

export const loadBalanceData = async () => {
  const data = await indexedDbAccessor.load<AmountByMonth>(StoreName.balanceData);
  const balanceData = new BalanceData();
  Object.entries(data).forEach(([key, value]) => {
    balanceData.set(key, new BalanceHistory(value));
  });
  return balanceData;
};

export const saveBudgetData = async (data: BudgetData) => {
  const entries = data.getEntries();
  await indexedDbAccessor.saveMany(StoreName.budgetData, entries);
};

export const loadBudgetData = async () => {
  const data = await indexedDbAccessor.load<BudgetSummaryByMonth>(StoreName.budgetData);
  const budgetData = new BudgetData();
  Object.entries(data).forEach(([key, value]) => {
    budgetData.set(key, new BudgetHistory(value));
  });
  return budgetData;
};

export const saveCapacityData = async (data: CapacityData) => {
  const entries = Array.from(data.entries());
  await indexedDbAccessor.saveMany(StoreName.capacityData, entries);
};

export const loadCapacityData = async () => {
  const data = await indexedDbAccessor.load<CapacitySummary>(StoreName.capacityData);
  const capacityData = new CapacityData();
  Object.entries(data).forEach(([key, value]) => {
    capacityData.set(key, value);
  });
  return capacityData;
};

export const saveTransactionFamilies = async (data: TransactionFamilies) => {
  const entries = data.getEntries();
  await indexedDbAccessor.saveMany(StoreName.transactionFamilies, entries);
};

export const loadTransactionFamilies = async () => {
  type DehydratedDictionary = Map<string, JSONSplitTransaction>;
  const data = await indexedDbAccessor.load<DehydratedDictionary>(StoreName.transactionFamilies);
  const transactionFamilies = new TransactionFamilies();
  Object.entries(data).forEach(([key, value]) => {
    // rehydrate
    const dict = new SplitTransactionDictionary();
    value.forEach((value, key) => dict.set(key, new SplitTransaction(value)));
    transactionFamilies.set(key, dict);
  });
  return transactionFamilies;
};

const saveDictionary = async <T>(storeName: StoreName, data: Dictionary<T>) => {
  const entries = Array.from(data.entries());
  await indexedDbAccessor.saveMany(storeName, entries);
};

const loadDictionary = async <T extends Dictionary>(
  storeName: StoreName,
  model: new (json: any) => any,
) => {
  const data = await indexedDbAccessor.load<JSON>(storeName);
  const dict = new Dictionary() as T;
  Object.entries(data).forEach(([key, value]) => {
    dict.set(key, new model(value));
  });
  return dict;
};

export const saveInstitutions = async (data: InstitutionDictionary) => {
  await saveDictionary(StoreName.institutions, data);
};

export const loadInstitutions = () => {
  return loadDictionary<InstitutionDictionary>(StoreName.institutions, Institution);
};

export const saveAccounts = async (data: AccountDictionary) => {
  await saveDictionary(StoreName.accounts, data);
};

export const loadAccounts = () => {
  return loadDictionary<AccountDictionary>(StoreName.accounts, Account);
};

export const saveTransactions = async (data: TransactionDictionary) => {
  await saveDictionary(StoreName.transactions, data);
};

export const loadTransactions = () => {
  return loadDictionary<TransactionDictionary>(StoreName.transactions, Transaction);
};

export const saveSplitTransactions = async (data: SplitTransactionDictionary) => {
  await saveDictionary(StoreName.splitTransactions, data);
};

export const loadSplitTransactions = () => {
  return loadDictionary<SplitTransactionDictionary>(StoreName.splitTransactions, SplitTransaction);
};

export const saveInvestmentTransactions = async (data: InvestmentTransactionDictionary) => {
  await saveDictionary(StoreName.investmentTransactions, data);
};

export const loadInvestmentTransactions = () => {
  return loadDictionary<InvestmentTransactionDictionary>(
    StoreName.investmentTransactions,
    InvestmentTransaction,
  );
};

export const saveBudgets = async (data: BudgetDictionary) => {
  await saveDictionary(StoreName.budgets, data);
};

export const loadBudgets = () => {
  return loadDictionary<BudgetDictionary>(StoreName.budgets, Budget);
};

export const saveSections = async (data: SectionDictionary) => {
  await saveDictionary(StoreName.sections, data);
};

export const loadSections = () => {
  return loadDictionary<SectionDictionary>(StoreName.sections, Section);
};

export const saveCategories = async (data: CategoryDictionary) => {
  await saveDictionary(StoreName.categories, data);
};

export const loadCategories = () => {
  return loadDictionary<CategoryDictionary>(StoreName.categories, Category);
};

export const saveItems = async (data: ItemDictionary) => {
  await saveDictionary(StoreName.items, data);
};

export const loadItems = () => {
  return loadDictionary<ItemDictionary>(StoreName.items, Item);
};

export const saveCharts = async (data: ChartDictionary) => {
  await saveDictionary(StoreName.charts, data);
};

export const loadCharts = () => {
  return loadDictionary<ChartDictionary>(StoreName.charts, Chart);
};

export const saveAccountSnapshots = async (data: AccountSnapshotDictionary) => {
  await saveDictionary(StoreName.accountSnapshots, data);
};

export const loadAccountSnapshots = () => {
  return loadDictionary<AccountSnapshotDictionary>(StoreName.accountSnapshots, AccountSnapshot);
};

export const saveHoldingSnapshots = async (data: HoldingSnapshotDictionary) => {
  await saveDictionary(StoreName.holdingSnapshots, data);
};

export const loadHoldingSnapshots = () => {
  return loadDictionary<HoldingSnapshotDictionary>(StoreName.holdingSnapshots, HoldingSnapshot);
};

export const saveSecuritySnapshots = async (data: SecuritySnapshotDictionary) => {
  await saveDictionary(StoreName.securitySnapshots, data);
};

export const loadSecuritySnapshots = () => {
  return loadDictionary<SecuritySnapshotDictionary>(StoreName.securitySnapshots, SecuritySnapshot);
};

export const clearAllData = async () => {
  const stores = Object.values(StoreName);
  const promises = stores.map((store) => indexedDbAccessor.clear(store));
  await Promise.all(promises);
};

export const saveAllData = async (data: Data) => {
  const {
    institutions,
    accounts,
    transactions,
    investmentTransactions,
    splitTransactions,
    budgets,
    sections,
    categories,
    items,
    charts,
    accountSnapshots,
    holdingSnapshots,
    securitySnapshots,
  } = data;

  await Promise.all([
    saveInstitutions(institutions),
    saveAccounts(accounts),
    saveTransactions(transactions),
    saveInvestmentTransactions(investmentTransactions),
    saveSplitTransactions(splitTransactions),
    saveBudgets(budgets),
    saveSections(sections),
    saveCategories(categories),
    saveItems(items),
    saveCharts(charts),
    saveAccountSnapshots(accountSnapshots),
    saveHoldingSnapshots(holdingSnapshots),
    saveSecuritySnapshots(securitySnapshots),
  ]);
};

export const loadAllData = async () => {
  const [
    institutions,
    accounts,
    transactions,
    investmentTransactions,
    splitTransactions,
    budgets,
    sections,
    categories,
    items,
    charts,
    accountSnapshots,
    holdingSnapshots,
    securitySnapshots,
  ] = await Promise.all([
    loadInstitutions(),
    loadAccounts(),
    loadTransactions(),
    loadInvestmentTransactions(),
    loadSplitTransactions(),
    loadBudgets(),
    loadSections(),
    loadCategories(),
    loadItems(),
    loadCharts(),
    loadAccountSnapshots(),
    loadHoldingSnapshots(),
    loadSecuritySnapshots(),
  ]);

  return new Data({
    institutions,
    accounts,
    transactions,
    investmentTransactions,
    splitTransactions,
    budgets,
    sections,
    categories,
    items,
    charts,
    accountSnapshots,
    holdingSnapshots,
    securitySnapshots,
  });
};

export const saveAllCalculations = async (data: Calculations) => {
  const { balanceData, budgetData, transactionFamilies, capacityData } = data;
  await Promise.all([
    saveBalanceData(balanceData),
    saveBudgetData(budgetData),
    saveTransactionFamilies(transactionFamilies),
    saveCapacityData(capacityData),
  ]);
};

type StoredModel =
  | Account
  | Institution
  | Transaction
  | InvestmentTransaction
  | SplitTransaction
  | Budget
  | Section
  | Category
  | Item
  | Chart
  | AccountSnapshot
  | HoldingSnapshot
  | SecuritySnapshot;

export const save = (data: StoredModel) => {
  let storeName: StoreName;
  switch (data.constructor) {
    case Account:
      storeName = StoreName.accounts;
      break;
    case Institution:
      storeName = StoreName.institutions;
      break;
    case Transaction:
      storeName = StoreName.transactions;
      break;
    case InvestmentTransaction:
      storeName = StoreName.investmentTransactions;
      break;
    case SplitTransaction:
      storeName = StoreName.splitTransactions;
      break;
    case Budget:
      storeName = StoreName.budgets;
      break;
    case Section:
      storeName = StoreName.sections;
      break;
    case Category:
      storeName = StoreName.categories;
      break;
    case Item:
      storeName = StoreName.items;
      break;
    case Chart:
      storeName = StoreName.charts;
      break;
    case AccountSnapshot:
      storeName = StoreName.accountSnapshots;
      break;
    case HoldingSnapshot:
      storeName = StoreName.holdingSnapshots;
      break;
    case SecuritySnapshot:
      storeName = StoreName.securitySnapshots;
      break;
    default:
      throw new Error(`unknown model: ${data.constructor.name}`);
  }
  return indexedDbAccessor.save(storeName, data.id, data);
};

export const remove = (storeName: StoreName, id: string) => {
  return indexedDbAccessor.delete(storeName, id);
};
