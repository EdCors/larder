/* Nutrition math: portion scaling, daily sums, and recipe per-serve
   estimates computed from data already attached to the user's foods.
   Coverage is always reported — missing data is never filled in. */

import { nameScore } from './match.js';
import { convertIngredient } from './units.js';

export const NUTRIENT_IDS = ['kcal', 'protein', 'carbs', 'sugars', 'fat', 'satfat', 'fiber', 'sodium'];

export function scaleNutrition(per100, grams) {
  const factor = grams / 100;
  const out = {};
  for (const id of NUTRIENT_IDS) {
    out[id] = per100[id] != null ? Math.round(per100[id] * factor * 10) / 10 : null;
  }
  if (out.kcal != null) out.kcal = Math.round(out.kcal);
  return out;
}

export function scaleServes(perServe, serves) {
  const out = {};
  for (const id of NUTRIENT_IDS) {
    out[id] = perServe[id] != null ? Math.round(perServe[id] * serves * 10) / 10 : null;
  }
  if (out.kcal != null) out.kcal = Math.round(out.kcal);
  return out;
}

export function sumNutrients(list) {
  const out = {};
  for (const id of NUTRIENT_IDS) out[id] = 0;
  for (const n of list) {
    if (!n) continue;
    for (const id of NUTRIENT_IDS) if (n[id] != null) out[id] += n[id];
  }
  for (const id of NUTRIENT_IDS) out[id] = Math.round(out[id] * 10) / 10;
  out.kcal = Math.round(out.kcal);
  return out;
}

/* All known foods with nutrition: pantry items + previously looked-up
   products. Used for recipe estimates and food search. */
export function buildFoodSources(pantryItems, cacheEntries) {
  const sources = [];
  const seen = new Set();
  for (const p of pantryItems) {
    if (!p.nutrition) continue;
    sources.push({ name: p.name, nutrition: p.nutrition, source: 'pantry' });
    seen.add(p.name.toLowerCase());
  }
  for (const c of cacheEntries) {
    if (!c.product || !c.product.nutrition) continue;
    if (seen.has(c.product.name.toLowerCase())) continue; // same food already in pantry
    sources.push({ name: c.product.name, nutrition: c.product.nutrition, source: 'scanned' });
    seen.add(c.product.name.toLowerCase());
  }
  return sources;
}

function bestSource(name, sources) {
  let best = null;
  let bestScore = 0;
  for (const s of sources) {
    const score = nameScore(name, s.name, { loose: true });
    if (score > bestScore) { best = s; bestScore = score; }
  }
  return bestScore >= 0.5 ? best : null;
}

/* Per-serve estimate for a recipe. Only ingredients whose amounts convert
   honestly to g/ml AND have known nutrition contribute; `covered` says how
   many of the recipe's ingredients that was. */
export function recipeNutrition(recipe, foodSources) {
  const parts = [];
  let covered = 0;
  for (const ing of recipe.ingredients) {
    if (ing.amount == null) continue;
    const src = bestSource(ing.name, foodSources);
    if (!src) continue;
    const basisUnit = src.nutrition.basis === 'ml' ? 'ml' : 'g';
    const grams = convertIngredient(ing.amount, ing.unit || 'ea', basisUnit);
    if (grams == null) continue;
    parts.push(scaleNutrition(src.nutrition, grams));
    covered++;
  }
  if (!parts.length) return { perServe: null, covered: 0, count: recipe.ingredients.length };
  const total = sumNutrients(parts);
  const perServe = {};
  for (const id of NUTRIENT_IDS) {
    perServe[id] = total[id] != null ? Math.round((total[id] / Math.max(1, recipe.servings)) * 10) / 10 : null;
  }
  perServe.kcal = Math.round(perServe.kcal);
  return { perServe, covered, count: recipe.ingredients.length };
}
