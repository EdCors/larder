/* Preference learning from actual behaviour: saving, liking, cooking,
   repeat-cooking are positive signals; swapping a meal out or dismissing it
   is negative. Weights accumulate per food-token, so recommendations start
   generic and sharpen with use. */

import { getSetting, setSetting } from './db.js';

const KEY = 'prefSignals';
const WEIGHTS = { save: 1, like: 2, unlike: -2, cook: 1.5, dismiss: -1.5 };
const CLAMP = 8;

const STOP = new Set([
  'with', 'and', 'the', 'for', 'quick', 'easy', 'simple', 'fresh', 'style',
  'recipe', 'homemade', 'classic', 'best', 'dinner', 'lunch', 'weeknight',
  'healthy', 'creamy', 'crispy', 'warm', 'cold', 'large', 'small', 'light',
]);

function recipeTokens(recipe) {
  const text = [recipe.title || '', ...(recipe.ingredients || []).map((i) => i.name || '')].join(' ');
  return [...new Set(
    text.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/)
      .filter((t) => t.length > 2 && !STOP.has(t))
      .map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t))
  )];
}

export async function loadPrefs() {
  return (await getSetting(KEY)) || { tokens: {}, updatedAt: null };
}

export async function recordSignal(recipe, kind) {
  const delta = WEIGHTS[kind];
  if (!delta || !recipe) return;
  const prefs = await loadPrefs();
  for (const token of recipeTokens(recipe)) {
    const next = (prefs.tokens[token] || 0) + delta;
    prefs.tokens[token] = Math.max(-CLAMP, Math.min(CLAMP, Math.round(next * 10) / 10));
  }
  prefs.updatedAt = Date.now();
  await setSetting(KEY, prefs);
}

/* Bounded boost/penalty for ranking; scaled down when few tokens overlap so
   thin evidence can't dominate. */
export function prefTokenScore(recipe, prefs) {
  if (!prefs || !prefs.tokens) return 0;
  const tokens = recipeTokens(recipe);
  if (!tokens.length) return 0;
  let sum = 0;
  let hits = 0;
  for (const t of tokens) {
    if (prefs.tokens[t] != null) { sum += prefs.tokens[t]; hits++; }
  }
  if (!hits) return 0;
  return Math.max(-3, Math.min(3, (sum / hits) * 0.6 * Math.min(1, hits / 4)));
}

/* Style hints for AI generation prompts. */
export function topPrefTokens(prefs, count = 8) {
  const entries = Object.entries(prefs?.tokens || {});
  return {
    liked: entries.filter(([, w]) => w >= 2).sort((a, b) => b[1] - a[1]).slice(0, count).map(([t]) => t),
    avoided: entries.filter(([, w]) => w <= -2).sort((a, b) => a[1] - b[1]).slice(0, count).map(([t]) => t),
  };
}
