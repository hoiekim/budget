const DB_NAME = "BudgetApp";
/** Bump with every store added: IndexedDB creates stores only during an upgrade. */
export const DB_VERSION = 6;
/** How long an open may wait before the page gives up on the cache for now. */
const OPEN_DEADLINE_MS = 3_000;

export enum StoreName {
  // primary data
  institutions = "institutions",
  accounts = "accounts",
  holdings = "holdings",
  securities = "securities",
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
  // Transfer pairs (suggested + confirmed) keyed by pair_id. Loaded
  // into `data.transfers` on warm boot, saved on cold-sync settle and
  // on each mutation so warm paths paint with the most recent pair
  // state instead of "no pairs until /api/transfers settles".
  transfers = "transfers",
  // Recurrings (suggested + confirmed) keyed by recurring_id. Loaded
  // into `data.recurrings` on warm boot, saved on cold-sync settle and
  // on each mutation so warm paths paint with the most recent state.
  recurrings = "recurrings",
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
  private blocked = false;
  /**
   * Called when this page upgrades an existing database. The stores the
   * upgrade creates are empty, so whatever delta cursor seeded the cache
   * before can't seed it now.
   */
  onUpgradeExisting: (() => void) | null = null;
  /**
   * Writes dropped because the cache was unavailable. A sync that dropped any
   * left the cache short of what it fetched, so it must not advance the cursor.
   */
  skippedWrites = 0;

  constructor(dbName = DB_NAME, dbVersion = DB_VERSION) {
    this.dbName = dbName;
    this.dbVersion = dbVersion;
  }

  isAvailable(): boolean {
    return this.available;
  }

  private opening: Promise<IDBDatabase> | null = null;

  private init = (): Promise<IDBDatabase> => {
    if (!this.available) return Promise.reject(new Error("IndexedDB is not available"));
    if (this.db) return Promise.resolve(this.db);
    this.opening ??= this.open().finally(() => {
      this.opening = null;
    });
    return this.opening;
  };

  private open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(this.dbName, this.dbVersion);
      } catch (err) {
        this.available = false;
        console.warn("IndexedDB unavailable; local caching disabled.", err);
        reject(err);
        return;
      }

      let settled = false;
      // Another tab holding an older version open keeps the upgrade waiting,
      // possibly until that tab closes, and only the first open waiting on it
      // hears `blocked`; later ones hear nothing. Waiting would hold up the
      // first sync, so past a deadline this page goes without the cache. The
      // request stays pending and finishes the upgrade when it can.
      const fallBack = () => {
        clearTimeout(deadline);
        if (settled) return;
        settled = true;
        this.blocked = true;
        this.available = false;
        console.warn("IndexedDB upgrade is blocked by another tab; local caching disabled.");
        reject(new Error("IndexedDB upgrade blocked"));
      };
      const deadline = setTimeout(fallBack, OPEN_DEADLINE_MS);
      request.onblocked = fallBack;

      request.onerror = () => {
        clearTimeout(deadline);
        this.available = false;
        console.warn("IndexedDB unavailable; local caching disabled.", request.error);
        if (settled) return;
        settled = true;
        reject(request.error);
      };
      request.onsuccess = () => {
        clearTimeout(deadline);
        const database = request.result;
        // Step aside when a newer version of the app opens the database.
        database.onversionchange = () => {
          database.close();
          if (this.db === database) this.db = null;
        };
        this.db = database;
        // The open that fell back finishes once the other tab lets go.
        if (this.blocked) {
          this.blocked = false;
          this.available = true;
        }
        if (settled) return;
        settled = true;
        resolve(database);
      };

      request.onupgradeneeded = (event) => {
        if (event.oldVersion > 0) this.onUpgradeExisting?.();
        const database = request.result;
        this.stores.forEach((storeName) => {
          if (!database.objectStoreNames.contains(storeName)) {
            database.createObjectStore(storeName);
          }
        });
      };
    });

  save = async (storeName: StoreName, key: string, data: unknown): Promise<void> => {
    if (!this.available) {
      this.skippedWrites++;
      return;
    }
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
    if (!this.available) {
      this.skippedWrites++;
      return;
    }
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
    if (!this.available) {
      this.skippedWrites++;
      return;
    }
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
    if (!this.available) {
      this.skippedWrites++;
      return;
    }
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
