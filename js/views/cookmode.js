/* Cook mode: step-by-step walkthrough, then a reviewed pantry deduction.
   Deductions are computed as suggestions only — the user sees and can edit
   every amount before anything is subtracted. */

import { el, openSheet, toast } from '../ui.js';
import { dbAll, dbGet, dbPut } from '../db.js';
import { matchPantry } from '../match.js';
import { convertIngredient, formatQty, unitById, ingredientUnitLabel } from '../units.js';
import { recipeCost } from '../cost.js';
import { recordSignal } from '../prefs.js';
import { checkStaples } from '../staples.js';

const X_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function fmtIngredient(ing) {
  const bits = [];
  if (ing.amount != null) bits.push(String(Math.round(ing.amount * 100) / 100));
  if (ing.unit) bits.push(ingredientUnitLabel(ing.unit));
  bits.push(ing.name);
  return bits.join(' ');
}

export function openCookMode(recipe, { onCooked } = {}) {
  // Screen 0 is the mise-en-place overview; then one screen per step.
  const screens = [null, ...recipe.steps];
  let index = 0;
  let wakeLock = null;

  const stepLabel = el('div', { class: 'cook-label' });
  const bar = el('div', { class: 'cook-bar-fill' });
  const content = el('div', { class: 'cook-content' });
  const backBtn = el('button', { class: 'btn btn-secondary' }, 'Back');
  const nextBtn = el('button', { class: 'btn btn-primary' });

  const overlay = el('div', { class: 'page cook' },
    el('div', { class: 'o-head' },
      el('button', { class: 'scan-round cook-close', 'aria-label': 'Close', html: X_ICON, onclick: close }),
      el('div', { class: 'o-title' }, el('h2', { class: 'cook-title' }, recipe.title))
    ),
    el('div', { class: 'cook-bar' }, bar),
    stepLabel,
    content,
    el('div', { class: 'o-foot' }, el('div', { class: 'sheet-actions', style: 'margin-top:0' }, backBtn, nextBtn))
  );

  function close() {
    if (wakeLock) wakeLock.release().catch(() => {});
    overlay.classList.remove('open');
    setTimeout(() => overlay.remove(), 360);
  }

  function render() {
    content.innerHTML = '';
    bar.style.width = `${((index + 1) / screens.length) * 100}%`;
    if (index === 0) {
      stepLabel.textContent = `Get ready · serves ${recipe.servings}`;
      content.append(
        el('div', { class: 'cook-ings' },
          ...recipe.ingredients.map((ing) => el('div', { class: 'cook-ing' }, fmtIngredient(ing))))
      );
    } else {
      stepLabel.textContent = `Step ${index} of ${recipe.steps.length}`;
      content.append(el('div', { class: 'cook-step' }, screens[index]));
    }
    backBtn.disabled = index === 0;
    const last = index === screens.length - 1;
    nextBtn.textContent = last ? 'I cooked this' : (index === 0 ? 'Start cooking' : 'Next');
  }

  backBtn.addEventListener('click', () => { if (index > 0) { index--; render(); } });
  nextBtn.addEventListener('click', () => {
    if (index < screens.length - 1) { index++; render(); return; }
    openDeductReview(recipe, { onCooked, closeCook: close });
  });

  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  render();

  if (navigator.wakeLock) {
    navigator.wakeLock.request('screen').then((wl) => { wakeLock = wl; }).catch(() => {});
  }
}

async function buildDeductions(recipe) {
  const pantry = (await dbAll('pantry')).filter((p) => p.quantity.amount > 0);
  return recipe.ingredients.map((ing) => {
    const match = matchPantry(ing.name, pantry);
    if (!match) return { ing, item: null };
    let amount = null;
    if (ing.amount != null) {
      amount = convertIngredient(ing.amount, ing.unit || 'ea', match.item.quantity.unit);
      if (amount != null) amount = Math.min(Math.round(amount * 100) / 100, match.item.quantity.amount);
    }
    return { ing, item: match.item, amount, include: amount != null && amount > 0 };
  });
}

export function openDeductReview(recipe, { onCooked, closeCook }) {
  openSheet({
    title: 'Update pantry',
    async build(body, api) {
      body.append(el('div', { class: 'review-loading' }, el('div', { class: 'spinner' })));
      const rows = await buildDeductions(recipe);
      body.innerHTML = '';

      const matched = rows.filter((r) => r.item);
      const unmatched = rows.filter((r) => !r.item);

      body.append(el('p', { class: 'deduct-intro' },
        'Check what gets deducted — edit any amount before confirming.'));

      const controls = [];
      if (matched.length) {
        const card = el('div', { class: 'card' });
        for (const r of matched) {
          const input = el('input', {
            class: 'qty-input d-amt', type: 'text', inputmode: 'decimal',
            value: r.amount != null ? String(r.amount) : '',
            placeholder: '0',
          });
          const check = el('input', { type: 'checkbox', checked: r.include });
          input.addEventListener('input', () => { check.checked = true; });
          controls.push({ r, input, check });
          const unitLabel = (unitById(r.item.quantity.unit) || { label: r.item.quantity.unit }).label;
          card.append(
            el('label', { class: 'd-row' },
              check,
              el('div', { class: 'd-main' },
                el('div', { class: 'd-name' }, r.item.name),
                el('div', { class: 'd-meta' }, `${fmtIngredient(r.ing)} · you have ${formatQty(r.item.quantity.amount, r.item.quantity.unit)}`),
                r.amount == null ? el('div', { class: 'd-meta d-warn' }, 'Couldn’t convert units — set the amount yourself') : null
              ),
              el('div', { class: 'd-input' }, input, el('span', { class: 'd-unit' }, unitLabel))
            )
          );
        }
        body.append(card);
      } else {
        body.append(el('div', { class: 'form-hint' }, 'None of the ingredients matched your pantry — nothing to deduct.'));
      }

      if (unmatched.length) {
        body.append(el('div', { class: 'deduct-unmatched' },
          `Not in your pantry: ${unmatched.map((r) => r.ing.name).join(', ')}`));
      }

      async function finish(applyDeductions) {
        let deducted = 0;
        const emptied = [];
        if (applyDeductions) {
          for (const { r, input, check } of controls) {
            if (!check.checked) continue;
            const amt = parseFloat(String(input.value).replace(',', '.'));
            if (!Number.isFinite(amt) || amt <= 0) continue;
            const item = await dbGet('pantry', r.item.id);
            if (!item) continue;
            item.quantity.amount = Math.max(0, Math.round((item.quantity.amount - amt) * 100) / 100);
            item.updatedAt = Date.now();
            if (item.quantity.amount === 0) emptied.push(item.name);
            await dbPut('pantry', item);
            deducted++;
          }
        }
        const rec = (await dbGet('recipes', recipe.id)) || recipe;
        rec.timesCooked = (rec.timesCooked || 0) + 1;
        rec.lastCookedAt = Date.now();
        // Rough cost-per-serve history, from real purchase prices at cook time
        const pantryNow = await dbAll('pantry');
        const cost = recipeCost(rec, pantryNow);
        if (cost.perServe != null) {
          rec.costHistory = [...(rec.costHistory || []), { at: Date.now(), perServe: cost.perServe }];
        }
        await dbPut('recipes', rec);
        recordSignal(rec, 'cook');
        api.close();
        if (closeCook) closeCook();
        const emptyNote = emptied.length ? ` · ${emptied.join(', ')} now empty` : '';
        toast(applyDeductions ? `Cooked! Deducted from ${deducted} item${deducted === 1 ? '' : 's'}${emptyNote}` : 'Cooked! Pantry left unchanged');
        if (onCooked) onCooked();
        if (applyDeductions) setTimeout(() => checkStaples(), 4500); // after the cooked toast

      }

      body.append(
        el('div', { class: 'sheet-actions' },
          el('button', { class: 'btn btn-secondary', onclick: () => finish(false) }, 'Skip'),
          el('button', { class: 'btn btn-primary', onclick: () => finish(true) }, matched.length ? 'Deduct & finish' : 'Finish')
        )
      );
    },
  });
}
