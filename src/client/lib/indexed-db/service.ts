import { BalanceData, AmountByMonth, BalanceHistory } from "client";
import { StoreName, indexedDb } from "./accessor";

export const saveBalanceData = (data: BalanceData) => {
  const promises: Promise<void>[] = [];
  data.forEach((balanceHistory, key) => {
    const promise = indexedDb.save(StoreName.BalanceData, key, balanceHistory.getData());
    promises.push(promise);
  });
  return Promise.all(promises);
};

export const loadBalanceData = async () => {
  const data = await indexedDb.load<AmountByMonth>(StoreName.BalanceData);
  const balanceData = new BalanceData();
  Object.entries(data).forEach(([key, value]) => {
    balanceData.set(key, new BalanceHistory(value));
  });
  return balanceData;
};
