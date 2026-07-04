/* Name-based matching: attach nutrition from the user's own history
   (barcode cache + pantry) and find pantry items an import can top up.
   Deliberately conservative — a wrong match is worse than no match. */

import { dbAll } from './db.js';
import { convert } from './units.js';

const STOP = new Set(['woolworths', 'coles', 'aldi', 'iga', 'essentials', 'homebrand', 'home', 'brand', 'the', 'of', 'with', 'fresh', 'australian', 'value']);

function tokens(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter((t) => t && !STOP.has(t))
    .map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t)); // cheap plural stem
}

export function nameScore(a, b, { loose = false } = {}) {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const jaccard = inter / (ta.size + tb.size - inter);
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let contained = true;
  for (const t of small) if (!big.has(t)) { contained = false; break; }
  // Full containment counts as a strong match. In strict mode a single short
  // shared token ("milk") is not enough on its own; loose mode (used for
  // recipe ingredients, where the result is always user-reviewed) allows it.
  if (contained && (loose || small.size >= 2 || [...small][0].length >= 6)) return Math.max(jaccard, 0.85);
  return jaccard;
}

/* Best pantry match for a generic ingredient name ("milk", "eggs").
   Loose by design — every use is behind a review screen. */
export function matchPantry(name, pantryItems) {
  let best = null;
  let bestScore = 0;
  for (const p of pantryItems) {
    const score = p.nameLower === String(name).toLowerCase() ? 1 : nameScore(name, p.name, { loose: true });
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return best && bestScore >= 0.5 ? { item: best, score: bestScore } : null;
}

/* Fill in nutrition (and barcode/brand) from previously scanned or entered
   products whose names match well. Instant and offline. */
export async function attachHistoryNutrition(items) {
  const [cache, pantry] = await Promise.all([dbAll('barcodeCache'), dbAll('pantry')]);
  const sources = [];
  for (const c of cache) {
    if (c.product && c.product.nutrition) {
      sources.push({ name: c.product.name, nutrition: c.product.nutrition, barcode: c.barcode, brand: c.product.brand || null });
    }
  }
  for (const p of pantry) {
    if (p.nutrition) sources.push({ name: p.name, nutrition: p.nutrition, barcode: p.barcode || null, brand: p.brand || null });
  }
  for (const item of items) {
    if (item.nutrition) continue;
    let best = null;
    let bestScore = 0;
    for (const s of sources) {
      const score = nameScore(item.name, s.name);
      if (score > bestScore) { best = s; bestScore = score; }
    }
    if (best && bestScore >= 0.65) {
      item.nutrition = best.nutrition;
      item.matchedFrom = 'history';
      if (!item.barcode) item.barcode = best.barcode;
      if (!item.brand) item.brand = best.brand;
    }
  }
  return items;
}

/* Find pantry items an imported line can top up (e.g. re-buying milk). */
export async function findMergeTargets(items) {
  const pantry = await dbAll('pantry');
  for (const item of items) {
    let best = null;
    let bestScore = 0;
    for (const p of pantry) {
      const score = p.nameLower === item.name.toLowerCase() ? 1 : nameScore(item.name, p.name);
      if (score > bestScore) { best = p; bestScore = score; }
    }
    if (best && bestScore >= 0.8) {
      item.mergeTarget = { id: best.id, name: best.name, quantity: best.quantity };
      item.mergeOn = convert(1, item.quantity.unit, best.quantity.unit) != null;
    }
  }
  return items;
}
