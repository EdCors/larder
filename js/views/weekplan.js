/* "Plan my week": proposes a full week of dinners from saved recipes and
   freshly AI-generated ones, balanced across pantry coverage, expiry
   urgency, budget, learned preferences and rough nutrition targets.
   Nothing commits until the user applies the reviewed plan; every swap is
   recorded as a negative preference signal. */

import { dbAll, dbPut, uuid, getSetting } from '../db.js';
import { el, openSheet, toast, fmtDateShort } from '../ui.js';
import { analyzeRecipe, preferenceScore, urgencyScore, nutritionFit, nutritionSummary } from '../recommend.js';
import { recipeCost, fmtMoney } from '../cost.js';
import { buildFoodSources, recipeNutrition } from '../nutrition.js';
import { loadPrefs, topPrefTokens, recordSignal } from '../prefs.js';
import { generateRecipe, getApiKey } from '../ai.js';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const LOCK_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="10.5" width="13" height="9.5" rx="2.5"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 6.8-1.2"/></svg>';
const LOCK_CLOSED = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="10.5" width="13" height="9.5" rx="2.5"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/></svg>';
const SWAP_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5"/></svg>';

export async function openWeekPlanner(dates, { onDone }) {
  const [recipes, pantryAll, cache, plans, budget, targets, prefs, hasKey] = await Promise.all([
    dbAll('recipes'), dbAll('pantry'), dbAll('barcodeCache'), dbAll('mealPlans'),
    getSetting('weeklyBudget'), getSetting('dinnerTargets'), loadPrefs(), getApiKey().then(Boolean),
  ]);
  const pantry = pantryAll.filter((p) => p.quantity.amount > 0);
  const sources = buildFoodSources(pantryAll, cache);
  const styleHints = topPrefTokens(prefs);
  const entryByDate = new Map(plans.filter((p) => dates.includes(p.date)).map((p) => [p.date, p]));
  const recipeById = new Map(recipes.map((r) => [r.id, r]));

  // One slot per day. Existing dinners start locked so planning never
  // clobbers what the user already placed — unlock a day to include it.
  const slots = dates.map((date, i) => {
    const entry = entryByDate.get(date) || null;
    const existing = entry ? recipeById.get(entry.recipeId) : null;
    return {
      date,
      day: DAY_NAMES[i],
      entry,
      recipe: existing || null, // saved recipe object
      draft: null,              // unsaved AI draft
      locked: !!existing,
      kind: existing ? 'existing' : 'empty',
      cycle: 0,                 // for "another saved pick"
    };
  });

  function slotRecipe(slot) { return slot.draft || slot.recipe; }
  function plannedTitles(except) {
    return slots.filter((s) => s !== except && slotRecipe(s)).map((s) => slotRecipe(s).title);
  }

  function scoreSaved(recipe, usedIds) {
    const a = analyzeRecipe(recipe, pantry);
    const n = recipeNutrition(recipe, sources);
    let score = -1.3 * a.missing.length
      + 0.7 * Math.min(3, urgencyScore(a.expiring))
      + preferenceScore(recipe, prefs)
      + 1.6 * nutritionFit(n.perServe, targets);
    if (usedIds.has(recipe.id)) score -= 6; // avoid repeats within the week
    return score;
  }

  function bestSaved(slot, offset = 0) {
    const usedIds = new Set(slots.filter((s) => s !== slot && s.recipe).map((s) => s.recipe.id));
    const ranked = recipes
      .map((r) => ({ r, s: scoreSaved(r, usedIds) }))
      .sort((a, b) => b.s - a.s);
    const pick = ranked[offset % Math.max(1, ranked.length)];
    return pick && pick.s > -4 ? pick.r : null;
  }

  // ── UI shell ──
  const listWrap = el('div', { class: 'o-list' });
  const statusEl = el('div', { class: 'form-hint', style: 'padding:0 4px' });
  const applyBtn = el('button', { class: 'btn btn-primary' }, 'Apply plan');
  let busy = false;

  const overlay = el('div', { class: 'page' },
    el('div', { class: 'o-head' },
      el('button', { class: 'o-cancel', onclick: close }, 'Cancel'),
      el('div', { class: 'o-title' },
        el('h2', {}, 'Plan my week'),
        el('div', { class: 'o-sub' }, `Week of ${fmtDateShort(dates[0])}`))
    ),
    listWrap,
    el('div', { class: 'o-foot' }, statusEl, applyBtn)
  );

  function close() {
    overlay.classList.remove('open');
    setTimeout(() => overlay.remove(), 360);
  }

  function setBusy(on, text = '') {
    busy = on;
    applyBtn.disabled = on;
    statusEl.textContent = text;
  }

  async function generateForSlot(slot) {
    const result = await generateRecipe({
      craving: '',
      serves: 2,
      budget: budget != null ? Math.round((budget / Math.max(1, slots.length)) * 100) / 100 : null,
      targets,
      styleHints,
      avoidTitles: plannedTitles(slot),
    });
    if (result.status === 'ok') {
      slot.draft = result.recipe;
      slot.recipe = null;
      slot.kind = 'ai';
      return true;
    }
    return result.message || 'generation failed';
  }

  async function fillEmptySlots() {
    const toFill = slots.filter((s) => !s.locked && !slotRecipe(s));
    for (const slot of toFill) {
      const saved = bestSaved(slot);
      const a = saved ? analyzeRecipe(saved, pantry) : null;
      // A saved recipe with most ingredients on hand wins the slot; otherwise
      // (or when nothing viable is left) generate something new.
      if (saved && a.missing.length <= 3) {
        slot.recipe = saved;
        slot.kind = 'saved';
      } else if (hasKey) {
        setBusy(true, `Generating ${slot.day}'s dinner with Claude…`);
        render();
        const ok = await generateForSlot(slot);
        if (ok !== true && saved) { slot.recipe = saved; slot.kind = 'saved'; }
      } else if (saved) {
        slot.recipe = saved;
        slot.kind = 'saved';
      }
      render();
    }
    setBusy(false, hasKey ? '' : 'No API key set — plan uses saved recipes only. Add a key via Recipes → + → Generate with AI.');
    render();
  }

  function swapSlot(slot) {
    if (busy) return;
    openSheet({
      title: `${slot.day} — swap dinner`,
      build(sheetBody, sheetApi) {
        sheetBody.append(
          el('div', { class: 'addopts', style: 'flex-direction:column' },
            el('button', {
              class: 'btn-scan',
              onclick: async () => {
                sheetApi.close();
                const old = slotRecipe(slot);
                if (old) recordSignal(old, 'dismiss');
                slot.cycle += 1;
                const next = bestSaved(slot, slot.cycle);
                if (next) { slot.recipe = next; slot.draft = null; slot.kind = 'saved'; }
                else toast('No other saved recipes to try');
                render();
              },
            }, 'Try another saved recipe'),
            hasKey ? el('button', {
              class: 'btn-scan',
              onclick: async () => {
                sheetApi.close();
                const old = slotRecipe(slot);
                if (old) recordSignal(old, 'dismiss');
                setBusy(true, `Generating a new ${slot.day} dinner…`);
                render();
                const ok = await generateForSlot(slot);
                if (ok !== true) toast(typeof ok === 'string' ? ok : 'Generation failed');
                setBusy(false);
                render();
              },
            }, 'Generate new with AI') : null,
            slotRecipe(slot) ? el('button', {
              class: 'btn-scan',
              onclick: () => {
                sheetApi.close();
                const old = slotRecipe(slot);
                if (old) recordSignal(old, 'dismiss');
                slot.recipe = null; slot.draft = null; slot.kind = 'empty';
                render();
              },
            }, 'Leave this night empty') : null
          )
        );
      },
    });
  }

  function render() {
    listWrap.innerHTML = '';
    listWrap.append(el('div', { class: 'week-nutrition' },
      'Muffin learns from what you cook, like and swap — early plans are more generic and sharpen with use.'));

    const card = el('div', { class: 'card', style: 'margin-top:12px' });
    let weekCost = 0;
    for (const slot of slots) {
      const recipe = slotRecipe(slot);
      let main;
      const side = [];
      if (recipe) {
        const n = recipeNutrition(recipe, sources);
        const c = recipeCost(recipe, pantry);
        if (c.total != null) weekCost += c.total;
        const summary = nutritionSummary(n, targets);
        const meta = [summary.text];
        if (c.perServe != null) meta.push(`~${fmtMoney(c.perServe)}/serve`);
        const tag = slot.kind === 'ai' ? 'new ✨' : slot.kind === 'existing' ? 'planned' : 'saved';
        const flag = summary.flag;
        main = el('div', { class: 'row-main' },
          el('div', { class: 'row-name', style: 'font-size:15.5px' }, recipe.title,
            el('span', { class: 'src-tag' }, tag)),
          el('div', { class: 'row-meta' }, meta.join(' · '),
            flag ? el('span', { class: `chip-exp ${flag.cls}`, style: 'margin-left:6px' }, flag.label) : null));
      } else {
        main = el('div', { class: 'row-main' }, el('div', { class: 'day-empty' }, 'Nothing planned'));
      }
      card.append(
        el('div', { class: 'o-row', style: 'cursor:default' },
          el('div', { class: 'day-label' },
            el('div', { class: 'day-name' }, slot.day),
            el('div', { class: 'day-num' }, String(parseInt(slot.date.slice(8), 10)))),
          main,
          el('button', {
            class: `icon-btn plan-lock${slot.locked ? ' on' : ''}`,
            'aria-label': slot.locked ? 'Unlock this dinner' : 'Lock this dinner',
            html: slot.locked ? LOCK_CLOSED : LOCK_OPEN,
            onclick: () => {
              slot.locked = !slot.locked;
              render();
              if (!slot.locked && !slotRecipe(slot)) fillEmptySlots();
            },
          }),
          slot.locked ? null : el('button', {
            class: 'icon-btn', 'aria-label': 'Swap this dinner', html: SWAP_ICON,
            onclick: () => swapSlot(slot),
          })
        )
      );
    }
    listWrap.append(card);

    const bits = [];
    if (budget != null) bits.push(`pantry-ingredient cost ~${fmtMoney(Math.round(weekCost * 100) / 100)} of ${fmtMoney(budget)} budget`);
    if (targets && (targets.kcal || targets.protein)) {
      const t = [];
      if (targets.kcal) t.push(`~${targets.kcal} kcal`);
      if (targets.protein) t.push(`~${targets.protein}g protein`);
      bits.push(`target ${t.join(' · ')} per serve`);
    }
    if (bits.length) listWrap.append(el('div', { class: 'list-count' }, bits.join(' · ')));
  }

  applyBtn.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true, 'Applying…');
    let planned = 0;
    for (const slot of slots) {
      let recipeId = null;
      if (slot.draft) {
        const saved = { ...slot.draft, id: uuid(), titleLower: slot.draft.title.toLowerCase(), liked: false, timesCooked: 0, lastCookedAt: null, createdAt: Date.now(), updatedAt: Date.now() };
        await dbPut('recipes', saved);
        recordSignal(saved, 'save');
        recipeId = saved.id;
      } else if (slot.recipe) {
        recipeId = slot.recipe.id;
      }
      if (recipeId) {
        await dbPut('mealPlans', {
          id: slot.entry?.id || uuid(),
          date: slot.date,
          recipeId,
          locked: slot.locked,
          addedAt: slot.entry?.addedAt || Date.now(),
          updatedAt: Date.now(),
        });
        planned++;
      }
    }
    toast(`Planned ${planned} dinner${planned === 1 ? '' : 's'}`);
    close();
    onDone();
  });

  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  render();
  fillEmptySlots();
}
