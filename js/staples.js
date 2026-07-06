/* Staples: items the user always wants on hand. When one dips to or below
   its top-up threshold (including mid-cook), it is flagged and added to the
   shopping list once per dip — the flag clears when it's restocked. */

import { dbAll, dbPut, uuid } from './db.js';
import { toast } from './ui.js';

export function stapleState(item) {
  if (!item.isStaple) return null;
  if (item.quantity.amount <= 0) return 'out';
  if (item.quantity.amount <= (item.lowAt ?? 0)) return 'low';
  return 'ok';
}

/* Run after any pantry quantity change. Returns names newly added. */
export async function checkStaples({ silent = false } = {}) {
  const [pantry, shopping] = await Promise.all([dbAll('pantry'), dbAll('shopping')]);
  const openNames = new Set(shopping.filter((s) => s.status === 'open').map((s) => s.nameLower));
  const added = [];

  for (const item of pantry) {
    if (!item.isStaple) continue;
    const state = stapleState(item);
    if (state === 'ok') {
      if (item.stapleFlagged) { item.stapleFlagged = false; await dbPut('pantry', item); }
      continue;
    }
    if (item.stapleFlagged) continue; // already handled this dip
    item.stapleFlagged = true;
    await dbPut('pantry', item);
    if (openNames.has(item.nameLower)) continue; // already on the list
    await dbPut('shopping', {
      id: uuid(),
      name: item.name,
      nameLower: item.nameLower,
      quantity: null,
      estCost: null,
      source: 'staple',
      reason: state === 'out' ? 'ran out' : 'below your top-up level',
      status: 'open',
      addedAt: Date.now(),
      updatedAt: Date.now(),
    });
    added.push(item.name);
  }

  if (added.length && !silent) {
    toast(`Added to shopping list: ${added.join(', ')}`);
  }
  return added;
}

/* Manual add at any time, threshold or not. */
export async function addStapleToList(item) {
  const shopping = await dbAll('shopping');
  if (shopping.some((s) => s.status === 'open' && s.nameLower === item.nameLower)) {
    toast(`${item.name} is already on the shopping list`);
    return;
  }
  await dbPut('shopping', {
    id: uuid(),
    name: item.name,
    nameLower: item.nameLower,
    quantity: null,
    estCost: null,
    source: 'staple',
    reason: 'added manually',
    status: 'open',
    addedAt: Date.now(),
    updatedAt: Date.now(),
  });
  toast(`${item.name} added to shopping list`);
}
