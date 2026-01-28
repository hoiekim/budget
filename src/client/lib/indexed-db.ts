import {
  Data,
  Account,
  Item,
  Transaction,
  SplitTransaction,
  InvestmentTransaction,
  AccountSnapshot,
  HoldingSnapshot,
  Budget,
  Section,
  Category,
  Chart,
  Dictionary,
} from "common";

const DB_NAME = "BudgetApp";
const DB_VERSION = 1;
const STORES: (keyof Data)[] = [
  "accounts",
  "items",
  "transactions",
  "splitTransactions",
  "investmentTransactions",
  "accountSnapshots",
  "holdingSnapshots",
  "budgets",
  "sections",
  "categories",
  "charts",
];

export class IndexedDb {
  private db: IDBDatabase | null = null;

  private dbName: string;
  private dbVersion: number;
  private stores: (keyof Data)[];

  constructor(dbName = DB_NAME, dbVersion = DB_VERSION, stores = STORES) {
    this.dbName = dbName;
    this.dbVersion = dbVersion;
    this.stores = stores;
  }

  private init = (): Promise<IDBDatabase> => {
    return new Promise((resolve, reject) => {
      if (this.db) {
        resolve(this.db);
        return;
      }

      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => reject(request.error);
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

  save = async (data: Data): Promise<void> => {
    const database = await this.init();
    const transaction = database.transaction(this.stores, "readwrite");

    const promises = this.stores.map((storeName) => {
      const store = transaction.objectStore(storeName);
      const dictionary = data[storeName];

      if (dictionary && typeof dictionary === "object" && "forEach" in dictionary) {
        const items: Promise<void>[] = [];
        dictionary.forEach((item, id) => {
          items.push(
            new Promise<void>((resolve, reject) => {
              const request = store.put(JSON.parse(JSON.stringify(item)), id);
              request.onerror = () => reject(request.error);
              request.onsuccess = () => resolve();
            }),
          );
        });
        return Promise.all(items);
      }
      return Promise.resolve();
    });

    await Promise.all(promises);
  };

  load = async (): Promise<Data | null> => {
    try {
      const database = await this.init();
      const transaction = database.transaction(this.stores, "readonly");
      const data = new Data();

      const loadStore = <T>(storeName: keyof Data, Constructor: new (item: any) => T) => {
        return new Promise<void>((resolve, reject) => {
          const store = transaction.objectStore(storeName);
          const request = store.openCursor();
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const cursor = request.result;
            if (cursor) {
              const { key, value } = cursor;
              if (typeof key === "string") {
                const dictionary = data[storeName] as Dictionary;
                dictionary.set(key, new Constructor(value));
              }
              cursor.continue();
            } else {
              resolve();
            }
          };
        });
      };

      await Promise.all([
        loadStore("accounts", Account),
        loadStore("items", Item),
        loadStore("transactions", Transaction),
        loadStore("splitTransactions", SplitTransaction),
        loadStore("investmentTransactions", InvestmentTransaction),
        loadStore("accountSnapshots", AccountSnapshot),
        loadStore("holdingSnapshots", HoldingSnapshot),
        loadStore("budgets", Budget),
        loadStore("sections", Section),
        loadStore("categories", Category),
        loadStore("charts", Chart),
      ]);

      return data;
    } catch {
      return null;
    }
  };
}

export const indexedDb = new IndexedDb();
