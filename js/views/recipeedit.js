/* Recipe editor — used for manual entry, editing, and reviewing extracted
   recipes before they save (the review-before-commit gate for pastes). */

import { el, openSheet, toast } from '../ui.js';
import { dbPut, dbDel, uuid } from '../db.js';
import { INGREDIENT_UNITS } from '../units.js';
import { parseRecipeText } from '../recipeparse.js';

const X_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

export function openRecipePaste({ onSaved }) {
  openSheet({
    title: 'Paste a recipe',
    build(body, api) {
      const ta = el('textarea', {
        class: 'field-input order-paste', rows: '8',
        placeholder: 'Paste recipe text — an Instagram caption, a web page, your notes. Larder can’t fetch links itself, so paste the words.',
      });
      const err = el('div', { class: 'form-hint form-warn' });
      body.append(
        el('div', { class: 'form-label' }, 'Recipe text'),
        ta, err,
        el('div', { class: 'sheet-actions' },
          el('button', {
            class: 'btn btn-primary',
            onclick: () => {
              const parsed = parseRecipeText(ta.value);
              if (parsed.onlyUrl) {
                err.textContent = 'That’s just a link — Instagram and most sites block fetching. Open the post and paste the caption or recipe text.';
                return;
              }
              if (!parsed.title && !parsed.ingredients.length && !parsed.steps.length) {
                err.textContent = 'Couldn’t find a recipe in that text.';
                return;
              }
              api.close();
              openRecipeEditor({
                title: parsed.title,
                servings: parsed.servings || 2,
                ingredients: parsed.ingredients,
                steps: parsed.steps,
                sourceUrl: parsed.sourceUrl,
                source: 'paste',
              }, { onSaved, extracted: true });
            },
          }, 'Extract recipe')
        )
      );
      setTimeout(() => ta.focus(), 120);
    },
  });
}

export function openRecipeEditor(initial = {}, { onSaved, onDeleted, extracted = false } = {}) {
  const existing = !!initial.id;
  const ingRows = [];

  const titleInput = el('input', {
    class: 'field-input', type: 'text', autocapitalize: 'words', autocomplete: 'off',
    placeholder: 'e.g. Creamy garlic pasta', value: initial.title || '',
  });

  let servings = initial.servings || 2;
  const servInput = el('input', { class: 'qty-input', type: 'text', inputmode: 'numeric', value: String(servings) });
  const servStepper = el('div', { class: 'stepper' },
    el('button', { 'aria-label': 'Fewer serves', onclick: () => { servings = Math.max(1, (parseInt(servInput.value, 10) || servings) - 1); servInput.value = String(servings); } }, '−'),
    servInput,
    el('button', { 'aria-label': 'More serves', onclick: () => { servings = (parseInt(servInput.value, 10) || servings) + 1; servInput.value = String(servings); } }, '+')
  );

  const ingList = el('div', {});
  function addIngRow(ing = {}) {
    const amt = el('input', { class: 'field-input ing-amt', type: 'text', inputmode: 'decimal', placeholder: '#', value: ing.amount != null ? String(Math.round(ing.amount * 100) / 100) : '' });
    const sel = el('select', { class: 'field-select ing-unit' },
      el('option', { value: '' }, '—'),
      ...INGREDIENT_UNITS.map((u) => el('option', { value: u.id, selected: ing.unit === u.id }, u.label))
    );
    const name = el('input', { class: 'field-input ing-name', type: 'text', placeholder: 'Ingredient', autocapitalize: 'words', value: ing.name || '' });
    const row = el('div', { class: 'ing-row' }, amt, sel, name,
      el('button', { class: 'ing-del', 'aria-label': 'Remove ingredient', html: X_ICON, onclick: () => { row.remove(); const i = ingRows.findIndex((r) => r.row === row); if (i >= 0) ingRows.splice(i, 1); } }));
    ingRows.push({ row, amt, sel, name });
    ingList.append(row);
  }
  (initial.ingredients?.length ? initial.ingredients : [{}, {}, {}]).forEach(addIngRow);

  const stepsTa = el('textarea', { class: 'field-input', rows: '9', placeholder: 'One step per line.' });
  stepsTa.value = (initial.steps || []).join('\n');

  const saveBtn = el('button', { class: 'btn btn-primary' }, existing ? 'Save changes' : 'Save recipe');
  const overlay = el('div', { class: 'page' },
    el('div', { class: 'o-head' },
      el('button', { class: 'o-cancel', onclick: close }, 'Cancel'),
      el('div', { class: 'o-title' }, el('h2', {}, existing ? 'Edit recipe' : 'New recipe'))
    ),
    el('div', { class: 'o-list' },
      extracted ? el('div', { class: 'notfound-note' }, 'Extracted from your pasted text — check everything below before saving.') : null,
      el('div', { class: 'form-label' }, 'Title'),
      titleInput,
      el('div', { class: 'form-label' }, 'Serves'),
      el('div', { class: 'qty-row' }, servStepper),
      el('div', { class: 'form-label' }, 'Ingredients'),
      ingList,
      el('button', { class: 'disclosure', onclick: () => addIngRow() }, '+ Add ingredient'),
      el('div', { class: 'form-label' }, 'Steps'),
      stepsTa
    ),
    el('div', { class: 'o-foot' },
      existing
        ? el('div', { class: 'sheet-actions', style: 'margin-top:0' },
            el('button', {
              class: 'btn btn-danger',
              onclick: async () => {
                await dbDel('recipes', initial.id);
                close();
                if (onDeleted) onDeleted();
                toast(`Deleted ${initial.title}`, {
                  action: 'Undo',
                  onAction: async () => { await dbPut('recipes', initial); if (onSaved) onSaved(initial); },
                });
              },
            }, 'Delete'),
            saveBtn)
        : saveBtn
    )
  );

  function close() {
    overlay.classList.remove('open');
    setTimeout(() => overlay.remove(), 360);
  }

  saveBtn.addEventListener('click', async () => {
    const title = titleInput.value.trim();
    const ingredients = ingRows
      .map(({ amt, sel, name }) => {
        const n = name.value.trim();
        if (!n) return null;
        const a = parseFloat(String(amt.value).replace(',', '.'));
        return {
          name: n.charAt(0).toUpperCase() + n.slice(1),
          amount: Number.isFinite(a) && a > 0 ? Math.round(a * 100) / 100 : null,
          unit: sel.value || null,
        };
      })
      .filter(Boolean);
    if (!title) {
      titleInput.classList.add('field-error');
      titleInput.focus();
      setTimeout(() => titleInput.classList.remove('field-error'), 1200);
      return;
    }
    if (!ingredients.length) {
      toast('Add at least one ingredient');
      return;
    }
    const recipe = {
      id: initial.id || uuid(),
      title,
      titleLower: title.toLowerCase(),
      servings: Math.max(1, parseInt(servInput.value, 10) || servings),
      ingredients,
      steps: stepsTa.value.split('\n').map((s) => s.trim()).filter(Boolean),
      sourceUrl: initial.sourceUrl || null,
      source: initial.source || 'manual',
      liked: initial.liked || false,
      timesCooked: initial.timesCooked || 0,
      lastCookedAt: initial.lastCookedAt || null,
      createdAt: initial.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    await dbPut('recipes', recipe);
    close();
    toast(existing ? 'Recipe updated' : `Saved ${recipe.title}`);
    if (onSaved) onSaved(recipe);
  });

  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
}
