/* Recipe recommendation scoring: pantry coverage, expiry urgency ("use it
   up"), personal preference (liked / cooked before), and craving search.
   Pure term-matching and arithmetic — no invented data. */

import { matchPantry } from './match.js';
import { daysUntil } from './ui.js';
import { prefTokenScore } from './prefs.js';

const QUERY_STOP = new Set([
  'something', 'anything', 'with', 'and', 'for', 'tonight', 'dinner', 'lunch',
  'breakfast', 'i', 'want', 'like', 'feel', 'craving', 'a', 'an', 'the', 'of',
  'to', 'make', 'me', 'some', 'using', 'have',
]);

function norm(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter((t) => t)
    .map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t));
}

/* How a recipe measures up against the current pantry. */
export function analyzeRecipe(recipe, pantry) {
  const missing = [];
  let have = 0;
  const seen = new Set();
  const expiring = [];
  for (const ing of recipe.ingredients) {
    const m = matchPantry(ing.name, pantry);
    if (m && m.item.quantity.amount > 0) {
      have++;
      if (m.item.expiryDate && !seen.has(m.item.id)) {
        seen.add(m.item.id);
        const days = daysUntil(m.item.expiryDate);
        if (days <= 7) expiring.push({ name: m.item.name, days });
      }
    } else {
      missing.push(ing.name);
    }
  }
  expiring.sort((a, b) => a.days - b.days);
  return { total: recipe.ingredients.length, have, missing, expiring };
}

/* Liked and previously-cooked recipes float upward; the learned preference
   profile (saves, cooks, likes, dismissals) adds a bounded boost/penalty. */
export const preferenceScore = (r, prefs = null) =>
  (r.liked ? 2 : 0) + Math.min(r.timesCooked || 0, 5) * 0.5 + (prefs ? prefTokenScore(r, prefs) : 0);

/* Rough closeness to the dinner targets, 0..1 (0.4 = unknown, 0.5 = no targets). */
export function nutritionFit(perServe, targets) {
  if (!targets || (!targets.kcal && !targets.protein)) return 0.5;
  if (!perServe) return 0.4;
  const fits = [];
  if (targets.kcal && perServe.kcal != null) {
    fits.push(Math.max(0, 1 - Math.abs(perServe.kcal - targets.kcal) / targets.kcal));
  }
  if (targets.protein && perServe.protein != null) {
    fits.push(Math.max(0, 1 - Math.abs(perServe.protein - targets.protein) / targets.protein));
  }
  return fits.length ? fits.reduce((a, b) => a + b, 0) / fits.length : 0.4;
}

/* Compact nutrition line for a planned dinner. Firm numbers and target flags
   only when at least half the ingredients have data — partial estimates are
   labelled as such and never flagged as "light". */
export function nutritionSummary(rn, targets) {
  if (!rn || !rn.perServe) return { text: 'no nutrition data', flag: null };
  const coverage = rn.covered / Math.max(1, rn.count);
  if (coverage < 0.5) {
    return { text: `~${rn.perServe.kcal}+ kcal (partial data, ${rn.covered}/${rn.count} ingredients)`, flag: null };
  }
  return {
    text: `~${rn.perServe.kcal} kcal · ${Math.round(rn.perServe.protein ?? 0)}g P /serve`,
    flag: nutritionFlag(rn.perServe, targets),
  };
}

/* Flag when a dinner is well off the rough targets. Returns {label, cls} or null. */
export function nutritionFlag(perServe, targets) {
  if (!targets || !perServe) return null;
  if (targets.kcal && perServe.kcal != null) {
    const ratio = perServe.kcal / targets.kcal;
    if (ratio >= 1.35) return { label: 'well over', cls: 'bad' };
    if (ratio >= 1.2) return { label: 'a bit over', cls: 'warn' };
    if (ratio <= 0.6) return { label: 'light', cls: 'warn' };
  }
  if (targets.protein && perServe.protein != null && perServe.protein < targets.protein * 0.55) {
    return { label: 'low protein', cls: 'warn' };
  }
  return null;
}

/* Urgency of the expiring pantry items a recipe would use. */
export const urgencyScore = (expiring) =>
  expiring.reduce((s, e) => s + (e.days <= 0 ? 3 : e.days <= 2 ? 2.5 : e.days <= 4 ? 2 : 1), 0);

/* Plain-language craving search: term overlap against title (weighted) and
   ingredients, with plural stemming and substring tolerance. */
export function cravingScore(recipe, query) {
  const terms = norm(query).filter((t) => !QUERY_STOP.has(t));
  if (!terms.length) return 0;
  const titleTokens = norm(recipe.title);
  const ingTokens = recipe.ingredients.flatMap((i) => norm(i.name));
  let score = 0;
  for (const t of terms) {
    if (titleTokens.some((x) => x.includes(t) || t.includes(x))) score += 2;
    else if (ingTokens.some((x) => x.includes(t) || t.includes(x))) score += 1;
  }
  return score;
}
