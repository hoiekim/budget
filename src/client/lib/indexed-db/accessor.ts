const DB_NAME = "BudgetApp";
const DB_VERSION = 2;

export enum StoreName {
  // primary data
  institutions = "institutions",
  accounts = "accounts",
  transactions = "transactions",
  investmentTransactions = "investmentTransactions",
  splitTransactions = "splitTransactions",
  budgets = "budgets",
  sections = "sections",
  categories = "categories",
  items = "items",
  charts = "charts",
  accountSnapshots = "accountSnapshots",
  holdingSnapshots = "holdingSnapshots",
  securitySnapshots = "securitySnapshots",
  // calculations
  balanceData = "balanceData",
  budgetData = "budgetData",
  capacityData = "capacityData",
  transactionFamilies = "transactionFamilies",
}

class IndexedDbAccessor {
  private db: IDBDatabase | null = null;
  private available = true;

  private dbName: string;
  private dbVersion: number;
  private stores = Object.values(StoreName);

  constructor(dbName = DB_NAME, dbVersion = DB_VERSION) {
    this.dbName = dbName;
    this.dbVersion = dbVersion;
  }

  isAvailable(): boolean {
    return this.available;
  }

  private init = (): Promise<IDBDatabase> => {
    return new Promise((resolve, reject) => {
      if (!this.available) {
        reject(new Error("IndexedDB is not available"));
        return;
      }

      if (this.db) {
        resolve(this.db);
        return;
      }

      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(this.dbName, this.dbVersion);
      } catch (err) {
        this.available = false;
        console.warn("IndexedDB unavailable; local caching disabled.", err);
        reject(err);
        return;
      }

      request.onerror = () => {
        this.available = false;
        console.warn("IndexedDB unavailable; local caching disabled.", request.error);
        reject(request.error);
      };
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onupgradeneeded = () => {
        const database = request.result;
        this.stores.forEach((storeName) => {
          if (!database.objectStoreNames.contains(storeName)) {
            database.createObjectStore(storeName);
          }
        });
      };
    });
  };

  save = async (storeName: StoreName, key: string, data: unknown): Promise<void> => {
    if (!this.available) return;
    const database = await this.init();
    const transaction = database.transaction(storeName, "readwrite");

    const store = transaction.objectStore(storeName);

    return await new Promise<void>((resolve, reject) => {
      const request = store.put(data, key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  };

  saveMany = async (storeName: StoreName, items: [string, unknown][]): Promise<void> => {
    if (!this.available) return;
    const database = await this.init();
    const transaction = database.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);

    return new Promise<void>((resolve, reject) => {
      transaction.onerror = () => reject(transaction.error);
      transaction.oncomplete = () => resolve();
      items.forEach(([key, data]) => store.put(data, key));
    });
  };

  delete = async (storeName: StoreName, key: string): Promise<void> => {
    if (!this.available) return;
    const database = await this.init();
    const transaction = database.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);

    return new Promise<void>((resolve, reject) => {
      const request = store.delete(key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  };

  load = async <T>(storeName: StoreName): Promise<{ [key: string]: T }> => {
    if (!this.available) return {};
    const database = await this.init();
    const transaction = database.transaction(storeName, "readonly");
    const store = transaction.objectStore(storeName);

    const keyPromise = new Promise<string[]>((resolve, _reject) => {
      const keys: string[] = [];
      const request = store.getAllKeys();
      request.onsuccess = () => {
        request.result.forEach((key, i) => {
          if (typeof key === "string") keys[i] = key;
        });
      };

      resolve(keys);
    });

    const valuePromise = new Promise<T[]>((resolve, reject) => {
      const values: T[] = [];
      const request = store.getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        request.result.forEach((value: T, i) => {
          values[i] = value;
        });
        resolve(values);
      };
    });

    const result: { [key: string]: T } = {};
    const [keys, values] = await Promise.all([keyPromise, valuePromise]);
    keys.forEach((key, i) => (result[key] = values[i]));

    return result;
  };

  clear = async (storeName: StoreName): Promise<void> => {
    if (!this.available) return;
    const database = await this.init();
    const transaction = database.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);

    return new Promise<void>((resolve, reject) => {
      const request = store.clear();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  };
}

export const indexedDbAccessor = new IndexedDbAccessor();
