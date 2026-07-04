/* Cost estimation from real purchase prices. An item's `price`/`priceQty`
   record what was actually paid for what amount; everything derives from
   that. Unknowns stay unknown — no invented prices. */

import { matchPantry } from './match.js';
import { convertIngredient } from './units.js';

export function unitPrice(item) {
  if (item.price == null || !item.priceQty || !item.priceQty.amount) return null;
  return { per: item.price / item.priceQty.amount, unit: item.priceQty.unit };
}

export function ingredientCost(ing, pantry) {
  if (ing.amount == null) return null;
  const m = matchPantry(ing.name, pantry);
  if (!m) return null;
  const up = unitPrice(m.item);
  if (!up) return null;
  const amount = convertIngredient(ing.amount, ing.unit || 'ea', up.unit);
  if (amount == null) return null;
  return amount * up.per;
}

/* { total, perServe, known, count } — total/perServe are null when no
   ingredient could be priced. */
export function recipeCost(recipe, pantry) {
  let total = 0;
  let known = 0;
  for (const ing of recipe.ingredients) {
    const c = ingredientCost(ing, pantry);
    if (c != null) { total += c; known++; }
  }
  if (!known) return { total: null, perServe: null, known: 0, count: recipe.ingredients.length };
  return {
    total: Math.round(total * 100) / 100,
    perServe: Math.round((total / Math.max(1, recipe.servings)) * 100) / 100,
    known,
    count: recipe.ingredients.length,
  };
}

export const fmtMoney = (n) => `$${n.toFixed(2)}`;
