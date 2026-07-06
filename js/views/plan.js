/* Plan tab: weekly dinner plan with budget tracking, a budget-aware
   pantry-first recipe picker, and shopping-list generation (reviewed). */

import { dbAll, dbPut, dbDel, uuid, getSetting, setSetting } from '../db.js';
import { el, openSheet, fmtDateShort } from '../ui.js';
import { convertIngredient, unitById } from '../units.js';
import { matchPantry } from '../match.js';
import { analyzeRecipe, preferenceScore } from '../recommend.js';
import { recipeCost, unitPrice, fmtMoney } from '../cost.js';
import { buildFoodSources, recipeNutrition, scaleServes, sumNutrients } from '../nutrition.js';
import { openShoppingReview, renderShopping } from './shopping.js';
import { openBudgetDinner } from './generate.js';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SEGS = [
  { id: 'week', label: 'Week' },
  { id: 'shopping', label: 'Shopping' },
];

let seg = localStorage.getItem('larder.plan.seg') || 'week';
let weekOffset = 0;
let bodyEl = null;
let ctxRef = null;

const iso = (d) => {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
};

function weekDates(offset) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset * 7);
  return Array.from({ length: 7 }, (_, i) => iso(new Date(d.getFullYear(), d.getMonth(), d.getDate() + i)));
}

export const planView = {
  async mount(container, ctx) {
    ctxRef = ctx;
    weekOffset = 0;
    const segEl = el('div', { class: 'segmented', role: 'group' });
    for (const s of SEGS) {
      segEl.append(el('button', {
        'aria-pressed': String(s.id === seg),
        onclick: (e) => {
          seg = s.id;
          localStorage.setItem('larder.plan.seg', seg);
          for (const b of segEl.children) b.setAttribute('aria-pressed', 'false');
          e.currentTarget.setAttribute('aria-pressed', 'true');
          render();
        },
      }, s.label));
    }
    container.append(el('div', { class: 'toolbar' }, segEl));
    bodyEl = el('div', { class: 'list-area' });
    container.append(bodyEl);
    await render();
  },
};

async function render() {
  if (!bodyEl) return;
  bodyEl.innerHTML = '';
  if (seg === 'week') await renderWeek();
  else await renderShopping(bodyEl, { onChanged: render, setSubtitle: (t) => ctxRef.setSubtitle(t) });
}

/* ── Week view ── */

async function renderWeek() {
  const [plans, recipes, pantryAll, budget, cache] = await Promise.all([
    dbAll('mealPlans'), dbAll('recipes'), dbAll('pantry'), getSetting('weeklyBudget'), dbAll('barcodeCache'),
  ]);
  const pantry = pantryAll.filter((p) => p.quantity.amount > 0);
  const dates = weekDates(weekOffset);
  const entryByDate = new Map(plans.filter((p) => dates.includes(p.date)).map((p) => [p.date, p]));
  const recipeById = new Map(recipes.map((r) => [r.id, r]));
  const costs = new Map(recipes.map((r) => [r.id, recipeCost(r, pantry)]));

  let weekTotal = 0;
  let unknowns = 0;
  for (const e of entryByDate.values()) {
    const c = costs.get(e.recipeId);
    if (c && c.total != null) weekTotal += c.total;
    else unknowns++;
  }
  weekTotal = Math.round(weekTotal * 100) / 100;

  ctxRef.setSubtitle(entryByDate.size
    ? `est ${fmtMoney(weekTotal)}${budget != null ? ` of ${fmtMoney(budget)}` : ''}${unknowns ? ` · ${unknowns} unpriced` : ''}`
    : '');

  // Budget card
  const pct = budget != null && budget > 0 ? Math.min(100, (weekTotal / budget) * 100) : 0;
  const barCls = budget != null && weekTotal > budget ? ' over' : (pct > 85 ? ' near' : '');
  bodyEl.append(
    el('button', { class: 'budget-card', onclick: () => openBudgetSheet(budget) },
      el('div', { class: 'budget-row' },
        el('span', { class: 'budget-label' }, 'Weekly dinner budget'),
        el('span', { class: 'budget-value' }, budget != null ? `${fmtMoney(weekTotal)} / ${fmtMoney(budget)}` : 'Set a budget')
      ),
      budget != null ? el('div', { class: 'budget-bar' }, el('div', { class: `budget-bar-fill${barCls}`, style: `width:${pct}%` })) : null
    )
  );

  // Nutrition profile of the planned week (Phase 7 tie-in)
  const foodSources = buildFoodSources(pantryAll, cache);
  const weekNutrition = [];
  let coveredIngs = 0;
  let totalIngs = 0;
  for (const e of entryByDate.values()) {
    const recipe = recipeById.get(e.recipeId);
    if (!recipe) continue;
    const rn = recipeNutrition(recipe, foodSources);
    totalIngs += rn.count;
    coveredIngs += rn.covered;
    if (rn.perServe) weekNutrition.push(scaleServes(rn.perServe, recipe.servings));
  }
  if (weekNutrition.length) {
    const wn = sumNutrients(weekNutrition);
    const partial = coveredIngs < totalIngs ? ` · based on ${coveredIngs} of ${totalIngs} ingredients` : '';
    bodyEl.append(el('div', { class: 'week-nutrition' },
      `Dinner nutrition this week: ~${wn.kcal.toLocaleString()} kcal · P ${Math.round(wn.protein)}g · C ${Math.round(wn.carbs)}g · F ${Math.round(wn.fat)}g${partial}`));
  }

  // Week navigation
  bodyEl.append(
    el('div', { class: 'week-nav' },
      el('button', { class: 'week-arrow', onclick: () => { weekOffset--; render(); } }, '‹'),
      el('span', { class: 'week-label' }, `Week of ${fmtDateShort(dates[0])}`),
      el('button', { class: 'week-arrow', onclick: () => { weekOffset++; render(); } }, '›')
    )
  );

  // Day rows
  const today = iso(new Date());
  const card = el('div', { class: 'card' });
  dates.forEach((date, i) => {
    const entry = entryByDate.get(date);
    const recipe = entry ? recipeById.get(entry.recipeId) : null;
    let main;
    if (recipe) {
      const a = analyzeRecipe(recipe, pantry);
      const c = costs.get(recipe.id);
      const meta = [`have ${a.have}/${a.total}`];
      if (c.perServe != null) meta.push(`~${fmtMoney(c.perServe)}/serve`);
      main = el('div', { class: 'row-main' },
        el('div', { class: 'row-name' }, recipe.title),
        el('div', { class: 'row-meta' }, meta.join(' · ')));
    } else {
      main = el('div', { class: 'row-main' }, el('div', { class: 'day-empty' }, 'Add dinner'));
    }
    card.append(
      el('button', { class: 'row', onclick: () => openPicker(date, entry, { budget, weekTotal, costs, pantry, recipes }) },
        el('div', { class: `day-label${date === today ? ' today' : ''}` },
          el('div', { class: 'day-name' }, DAY_NAMES[i]),
          el('div', { class: 'day-num' }, String(parseInt(date.slice(8), 10)))),
        main
      )
    );
  });
  bodyEl.append(card);

  bodyEl.append(
    el('button', {
      class: 'btn-scan', style: 'margin-top:14px',
      onclick: () => buildShoppingProposal(dates),
    }, 'Build shopping list for this week'),
    el('button', {
      class: 'btn-scan', style: 'margin-top:10px',
      onclick: () => openBudgetDinner({ onSaved: render }),
    }, 'Dinner on a budget')
  );
}

function openBudgetSheet(current) {
  openSheet({
    title: 'Weekly dinner budget',
    build(body, api) {
      const input = el('input', { class: 'field-input', type: 'text', inputmode: 'decimal', placeholder: 'e.g. 70' });
      input.value = current != null ? String(current) : '';
      body.append(
        el('div', { class: 'form-label' }, 'Budget for the week’s dinners ($)'),
        input,
        el('div', { class: 'sheet-actions' },
          el('button', {
            class: 'btn btn-primary',
            onclick: async () => {
              const n = parseFloat(String(input.value).replace(',', '.').replace('$', ''));
              await setSetting('weeklyBudget', Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null);
              api.close();
              render();
            },
          }, 'Save')
        )
      );
      setTimeout(() => input.focus(), 120);
    },
  });
}

/* ── Recipe picker for a day ── */

function openPicker(date, entry, { budget, weekTotal, costs, pantry, recipes }) {
  openSheet({
    title: `Dinner · ${DAY_NAMES[(new Date(date).getDay() + 6) % 7]} ${fmtDateShort(date)}`,
    build(body, api) {
      if (entry) {
        body.append(el('button', {
          class: 'btn btn-danger', style: 'margin:6px 0 4px; width:100%',
          onclick: async () => { await dbDel('mealPlans', entry.id); api.close(); render(); },
        }, 'Remove this dinner'));
      }
      if (!recipes.length) {
        body.append(el('div', { class: 'form-hint' }, 'No recipes yet — add some in the Recipes tab first.'));
        return;
      }

      const currentCost = entry ? (costs.get(entry.recipeId)?.total || 0) : 0;
      const remaining = budget != null ? budget - (weekTotal - currentCost) : null;

      const ranked = [...recipes].sort((a, b) =>
        analyzeRecipe(a, pantry).missing.length - analyzeRecipe(b, pantry).missing.length
        || preferenceScore(b) - preferenceScore(a)
        || a.titleLower.localeCompare(b.titleLower));

      body.append(el('div', { class: 'form-label' },
        remaining != null ? `Suggestions · ${fmtMoney(Math.max(0, remaining))} left this week` : 'Suggestions'));
      const card = el('div', { class: 'card' });
      for (const r of ranked) {
        const a = analyzeRecipe(r, pantry);
        const c = costs.get(r.id);
        const meta = [`have ${a.have}/${a.total}`];
        if (c.total != null) meta.push(`${fmtMoney(c.total)} (~${fmtMoney(c.perServe)}/serve)`);
        else meta.push('cost unknown');
        const over = c.total != null && remaining != null && c.total > remaining;
        card.append(
          el('button', {
            class: 'row',
            onclick: async () => {
              const record = entry
                ? { ...entry, recipeId: r.id, updatedAt: Date.now() }
                : { id: uuid(), date, recipeId: r.id, addedAt: Date.now(), updatedAt: Date.now() };
              await dbPut('mealPlans', record);
              api.close();
              render();
            },
          },
            el('div', { class: 'row-main' },
              el('div', { class: 'row-name' }, r.title),
              el('div', { class: 'row-meta' }, meta.join(' · '))),
            over ? el('span', { class: 'chip-exp bad' }, 'over budget') : null
          )
        );
      }
      body.append(card);
    },
  });
}

/* ── Shopping list generation (always reviewed before saving) ── */

async function buildShoppingProposal(dates) {
  const [plans, recipes, pantryAll, shopping] = await Promise.all([
    dbAll('mealPlans'), dbAll('recipes'), dbAll('pantry'), dbAll('shopping'),
  ]);
  const recipeById = new Map(recipes.map((r) => [r.id, r]));
  const entries = plans.filter((p) => dates.includes(p.date));
  const openNames = new Set(shopping.filter((s) => s.status === 'open').map((s) => s.nameLower));

  const usage = new Map();    // pantry item id → cumulative need across the week
  const unmatched = new Map(); // ingredient name → need

  for (const e of entries) {
    const recipe = recipeById.get(e.recipeId);
    if (!recipe) continue;
    for (const ing of recipe.ingredients) {
      const m = matchPantry(ing.name, pantryAll);
      if (m) {
        if (ing.amount == null) continue; // unquantified ("to taste") — assume covered
        const conv = convertIngredient(ing.amount, ing.unit || 'ea', m.item.quantity.unit);
        if (conv != null) {
          const u = usage.get(m.item.id) || { item: m.item, needed: 0, recipes: new Set() };
          u.needed += conv;
          u.recipes.add(recipe.title);
          usage.set(m.item.id, u);
          continue;
        }
      }
      const key = ing.name.toLowerCase();
      const u = unmatched.get(key) || { name: ing.name, amount: null, unit: ing.unit, recipes: new Set() };
      if (ing.amount != null) {
        if (u.amount == null) { u.amount = ing.amount; u.unit = ing.unit; }
        else {
          const conv = convertIngredient(ing.amount, ing.unit || 'ea', u.unit || 'ea');
          if (conv != null) u.amount = Math.round((u.amount + conv) * 100) / 100;
        }
      }
      u.recipes.add(recipe.title);
      unmatched.set(key, u);
    }
  }

  const proposals = [];
  for (const { item, needed, recipes: recSet } of usage.values()) {
    const shortfall = Math.round((needed - item.quantity.amount) * 100) / 100;
    if (shortfall <= 0) continue;
    const up = unitPrice(item);
    proposals.push({
      name: item.name,
      amount: shortfall,
      unit: item.quantity.unit,
      estCost: up ? Math.round(shortfall * up.per * 100) / 100 : null,
      source: 'plan',
      reason: `for ${[...recSet].slice(0, 2).join(', ')}`,
      already: openNames.has(item.nameLower),
      include: !openNames.has(item.nameLower),
    });
  }
  for (const u of unmatched.values()) {
    proposals.push({
      name: u.name,
      amount: u.amount,
      unit: u.unit || 'ea',
      estCost: null,
      source: 'plan',
      reason: `for ${[...u.recipes].slice(0, 2).join(', ')}`,
      already: openNames.has(u.name.toLowerCase()),
      include: u.amount != null && !openNames.has(u.name.toLowerCase()),
    });
  }
  for (const item of pantryAll) {
    if (!item.isStaple) continue;
    if (item.quantity.amount > (item.lowAt ?? 0)) continue;
    proposals.push({
      name: item.name,
      amount: null,
      unit: item.quantity.unit,
      estCost: null,
      source: 'staple',
      reason: `running low — ${item.quantity.amount} ${unitById(item.quantity.unit)?.label || item.quantity.unit} left`,
      already: openNames.has(item.nameLower),
      include: !openNames.has(item.nameLower),
    });
  }

  openShoppingReview(proposals, {
    onDone: () => {
      seg = 'shopping';
      localStorage.setItem('larder.plan.seg', seg);
      render();
    },
  });
}
