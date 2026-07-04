/* Full-data backup and restore. Everything lives in the browser's IndexedDB,
   so the export file is the user's only off-device copy. */

import { dbAll, dbPut, dbClear } from './db.js';

const STORES = ['pantry', 'recipes', 'mealPlans', 'shopping', 'nutritionLogs', 'wasteLog', 'barcodeCache', 'settings'];

export async function collectBackup() {
  const data = {};
  for (const store of STORES) data[store] = await dbAll(store);
  return { app: 'larder', version: 1, exportedAt: new Date().toISOString(), data };
}

export function validateBackup(obj) {
  return !!(obj && obj.app === 'larder' && obj.data && typeof obj.data === 'object');
}

export function summarizeBackup(obj) {
  const count = (s) => (Array.isArray(obj.data[s]) ? obj.data[s].length : 0);
  return {
    exportedAt: obj.exportedAt || null,
    pantry: count('pantry'),
    recipes: count('recipes'),
    mealPlans: count('mealPlans'),
    shopping: count('shopping'),
    nutritionLogs: count('nutritionLogs'),
    wasteLog: count('wasteLog'),
  };
}

/* Replaces the contents of every store with the backup's. */
export async function applyBackup(obj) {
  for (const store of STORES) {
    await dbClear(store);
    for (const record of obj.data[store] || []) await dbPut(store, record);
  }
}

/* Export via the iOS share sheet where possible (saves to Files/AirDrop);
   falls back to a plain download elsewhere. */
export async function exportBackup() {
  const backup = await collectBackup();
  const json = JSON.stringify(backup, null, 1);
  const name = `larder-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([json], name, { type: 'application/json' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Larder backup' });
      return 'shared';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
      // fall through to download
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return 'downloaded';
}
