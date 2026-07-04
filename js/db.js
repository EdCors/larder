/* IndexedDB layer. All stores for every phase are declared up front so later
   phases don't need schema migrations. */

const DB_NAME = 'larder';
const DB_VERSION = 1;
let _db = null;

export function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const mk = (name, opts, indexes = []) => {
        if (db.objectStoreNames.contains(name)) return;
        const store = db.createObjectStore(name, opts);
        for (const [idxName, keyPath, idxOpts] of indexes) store.createIndex(idxName, keyPath, idxOpts || {});
      };
      mk('pantry', { keyPath: 'id' }, [
        ['nameLower', 'nameLower'],
        ['expiryDate', 'expiryDate'],
        ['category', 'category'],
        ['barcode', 'barcode'],
      ]);
      mk('recipes', { keyPath: 'id' }, [['titleLower', 'titleLower']]);
      mk('mealPlans', { keyPath: 'id' }, [['date', 'date']]);
      mk('shopping', { keyPath: 'id' }, [['status', 'status']]);
      mk('nutritionLogs', { keyPath: 'id' }, [['date', 'date']]);
      mk('wasteLog', { keyPath: 'id' }, [['date', 'date']]);
      mk('barcodeCache', { keyPath: 'barcode' });
      mk('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(storeName, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const request = fn(t.objectStore(storeName));
    t.oncomplete = () => resolve(request ? request.result : undefined);
    t.onabort = () => reject(t.error);
    t.onerror = () => reject(t.error);
  }));
}

export const dbAll = (store) => tx(store, 'readonly', (s) => s.getAll());
export const dbGet = (store, key) => tx(store, 'readonly', (s) => s.get(key));
export const dbPut = (store, value) => tx(store, 'readwrite', (s) => s.put(value));
export const dbDel = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));

export const uuid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export async function getSetting(key, fallback = null) {
  const row = await dbGet('settings', key);
  return row ? row.value : fallback;
}
export const setSetting = (key, value) => dbPut('settings', { key, value });
