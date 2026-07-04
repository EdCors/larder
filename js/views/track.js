/* Track tab: MyFitnessPal-style daily nutrition log. Foods come from the
   user's own scanned/imported items, recipes, Open Food Facts, USDA
   FoodData Central, or manual entry — portions are always confirmed
   (and editable) before anything is logged. */

import { dbAll, dbPut, dbDel, uuid, getSetting, setSetting } from '../db.js';
import { el, openSheet, toast, debounce, fmtDateShort, todayISO } from '../ui.js';
import { NUTRIENTS } from '../itemform.js';
import { NUTRIENT_IDS, scaleNutrition, scaleServes, sumNutrients, buildFoodSources, recipeNutrition } from '../nutrition.js';
import { searchProducts } from '../off.js';
import { searchUsda } from '../usda.js';

const MEALS = [
  ['breakfast', 'Breakfast'],
  ['lunch', 'Lunch'],
  ['dinner', 'Dinner'],
  ['snacks', 'Snacks'],
];

const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.8-3.8"/></svg>';

let dayOffset = 0;
let bodyEl = null;
let ctxRef = null;
let dayLabelEl = null;

const currentDate = () => todayISO(dayOffset);
const dayLabel = () => (dayOffset === 0 ? 'Today' : dayOffset === -1 ? 'Yesterday' : fmtDateShort(currentDate()));

export const trackView = {
  async mount(container, ctx) {
    ctxRef = ctx;
    dayOffset = 0;
    dayLabelEl = el('span', { class: 'week-label' });
    container.append(
      el('div', { class: 'toolbar' },
        el('div', { class: 'week-nav', style: 'padding:2px 0 4px' },
          el('button', { class: 'week-arrow', onclick: () => { dayOffset--; render(); } }, '‹'),
          dayLabelEl,
          el('button', { class: 'week-arrow', onclick: () => { if (dayOffset < 0) { dayOffset++; render(); } } }, '›')
        )
      )
    );
    bodyEl = el('div', { class: 'list-area' });
    container.append(bodyEl);
    await render();
  },
};

const fmtG = (v) => (v == null ? '—' : `${Math.round(v)}g`);

async function render() {
  if (!bodyEl) return;
  dayLabelEl.textContent = dayLabel();
  const date = currentDate();
  const [allLogs, targets] = await Promise.all([dbAll('nutritionLogs'), getSetting('nutritionTargets')]);
  const logs = allLogs.filter((l) => l.date === date);
  const totals = sumNutrients(logs.map((l) => l.nutrients));

  ctxRef.setSubtitle(logs.length
    ? `${totals.kcal.toLocaleString()} kcal${targets?.kcal ? ` of ${targets.kcal.toLocaleString()}` : ''} · ${dayLabel().toLowerCase()}`
    : '');

  bodyEl.innerHTML = '';

  // Summary card (tap to edit targets)
  const kcalPct = targets?.kcal ? Math.min(100, (totals.kcal / targets.kcal) * 100) : 0;
  const over = targets?.kcal && totals.kcal > targets.kcal;
  const macroCell = (label, val, target) =>
    el('div', { class: 'macro-cell' },
      el('div', { class: 'macro-label' }, label),
      el('div', { class: 'macro-val' }, `${fmtG(val)}${target ? ` / ${target}g` : ''}`)
    );
  bodyEl.append(
    el('button', { class: 'budget-card', onclick: () => openTargetsSheet(targets) },
      el('div', { class: 'budget-row' },
        el('span', { class: 'kcal-big' }, `${totals.kcal.toLocaleString()} kcal`),
        el('span', { class: 'budget-label' }, targets?.kcal ? `target ${targets.kcal.toLocaleString()}` : 'Set targets')
      ),
      targets?.kcal ? el('div', { class: 'budget-bar' }, el('div', { class: `budget-bar-fill${over ? ' over' : kcalPct > 85 ? ' near' : ''}`, style: `width:${kcalPct}%` })) : null,
      el('div', { class: 'macro-grid' },
        macroCell('Protein', totals.protein, targets?.protein),
        macroCell('Carbs', totals.carbs, targets?.carbs),
        macroCell('Fat', totals.fat, targets?.fat)
      )
    )
  );

  // Meals
  for (const [mealId, mealLabel] of MEALS) {
    const entries = logs.filter((l) => l.meal === mealId).sort((a, b) => a.createdAt - b.createdAt);
    const mealKcal = sumNutrients(entries.map((e) => e.nutrients)).kcal;
    const card = el('div', { class: 'card', style: 'margin-top:14px' });
    card.append(el('div', { class: 'meal-head' },
      el('span', {}, mealLabel),
      el('span', { class: 'meal-kcal' }, entries.length ? `${mealKcal.toLocaleString()} kcal` : '')));
    for (const entry of entries) {
      const portion = entry.kind === 'serve'
        ? `${entry.amount} serve${entry.amount === 1 ? '' : 's'}`
        : entry.kind === 'per100' ? `${entry.amount} ${entry.unit}` : 'manual';
      card.append(
        el('button', { class: 'row log-row', onclick: () => openPortionSheet({ date, meal: mealId, existing: entry }) },
          el('div', { class: 'row-main' },
            el('div', { class: 'row-name', style: 'font-size:15.5px' }, entry.name),
            el('div', { class: 'row-meta' }, `${portion} · P ${fmtG(entry.nutrients.protein)} · C ${fmtG(entry.nutrients.carbs)} · F ${fmtG(entry.nutrients.fat)}`)),
          el('div', { class: 'row-qty' }, `${entry.nutrients.kcal ?? 0} kcal`)
        )
      );
    }
    card.append(el('button', { class: 'meal-add', onclick: () => openAddFood(date, mealId) }, `+ Add to ${mealLabel.toLowerCase()}`));
    bodyEl.append(card);
  }
}

/* ── Targets ── */

function openTargetsSheet(current) {
  openSheet({
    title: 'Daily targets',
    async build(body, api) {
      const mkInput = (val) => el('input', { class: 'field-input', type: 'text', inputmode: 'numeric', value: val != null ? String(val) : '', placeholder: 'none' });
      const kcal = mkInput(current?.kcal);
      const protein = mkInput(current?.protein);
      const carbs = mkInput(current?.carbs);
      const fat = mkInput(current?.fat);
      const usdaKey = el('input', { class: 'field-input', type: 'text', autocomplete: 'off', placeholder: 'optional — improves USDA search limits' });
      usdaKey.value = (await getSetting('usdaKey')) || '';
      const grid = el('div', { class: 'nutri-grid' },
        el('div', { class: 'nutri-cell' }, el('label', {}, 'Energy (kcal)'), kcal),
        el('div', { class: 'nutri-cell' }, el('label', {}, 'Protein (g)'), protein),
        el('div', { class: 'nutri-cell' }, el('label', {}, 'Carbs (g)'), carbs),
        el('div', { class: 'nutri-cell' }, el('label', {}, 'Fat (g)'), fat)
      );
      body.append(
        el('div', { class: 'form-label' }, 'Targets'),
        grid,
        el('div', { class: 'form-label' }, 'USDA API key'),
        usdaKey,
        el('div', { class: 'sheet-actions' },
          el('button', {
            class: 'btn btn-primary',
            onclick: async () => {
              const num = (i) => { const n = parseFloat(i.value); return Number.isFinite(n) && n > 0 ? Math.round(n) : null; };
              const t = { kcal: num(kcal), protein: num(protein), carbs: num(carbs), fat: num(fat) };
              await setSetting('nutritionTargets', Object.values(t).some((v) => v != null) ? t : null);
              await setSetting('usdaKey', usdaKey.value.trim() || null);
              api.close();
              render();
            },
          }, 'Save')
        )
      );
    },
  });
}

/* ── Food search ── */

function foodRow({ name, meta, tag }, onPick) {
  return el('button', { class: 'off-result', onclick: onPick },
    el('div', { class: 'off-r-name' }, name, tag ? el('span', { class: 'src-tag' }, tag) : null),
    el('div', { class: 'off-r-meta' }, meta)
  );
}

function per100Meta(n) {
  return `${n.kcal != null ? `${n.kcal} kcal` : 'partial data'} · P ${fmtG(n.protein)} · C ${fmtG(n.carbs)} · F ${fmtG(n.fat)} per 100${n.basis}`;
}

async function openAddFood(date, meal) {
  const [pantry, cache, recipes, logs] = await Promise.all([
    dbAll('pantry'), dbAll('barcodeCache'), dbAll('recipes'), dbAll('nutritionLogs'),
  ]);
  const sources = buildFoodSources(pantry, cache);
  const mealLabel = MEALS.find((m) => m[0] === meal)[1];

  openSheet({
    title: `Add to ${mealLabel.toLowerCase()}`,
    build(body, api) {
      const input = el('input', { class: 'field-input', type: 'search', placeholder: 'Search your foods & recipes', autocomplete: 'off' });
      const results = el('div', { class: 'off-results' });
      const onlineEl = el('div', { class: 'off-results' });

      const pick = (opts) => { api.close(); openPortionSheet({ date, meal, ...opts }); };

      function renderLocal() {
        results.innerHTML = '';
        onlineEl.innerHTML = '';
        const q = input.value.trim().toLowerCase();

        if (!q) {
          const seen = new Set();
          const recent = [...logs].sort((a, b) => b.createdAt - a.createdAt)
            .filter((l) => { const k = l.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
            .slice(0, 8);
          if (recent.length) {
            results.append(el('div', { class: 'form-label' }, 'Recent'));
            for (const r of recent) {
              results.append(foodRow({ name: r.name, meta: `${r.nutrients.kcal ?? 0} kcal last time`, tag: 'recent' },
                () => pick({ name: r.name, kind: r.kind, base: r.base, initialAmount: r.amount, initialUnit: r.unit })));
            }
          }
          return;
        }

        const matches = sources.filter((s) => s.name.toLowerCase().includes(q)).slice(0, 8);
        for (const s of matches) {
          results.append(foodRow({ name: s.name, meta: per100Meta(s.nutrition), tag: s.source },
            () => pick({ name: s.name, kind: 'per100', base: { per100: s.nutrition } })));
        }
        for (const r of recipes.filter((r) => r.titleLower.includes(q)).slice(0, 4)) {
          const rn = recipeNutrition(r, sources);
          if (rn.perServe) {
            results.append(foodRow({
              name: r.title,
              meta: `${rn.perServe.kcal} kcal/serve · based on ${rn.covered} of ${rn.count} ingredients`,
              tag: 'recipe',
            }, () => pick({ name: r.title, kind: 'serve', base: { perServe: rn.perServe, note: `${rn.covered} of ${rn.count} ingredients` } })));
          } else {
            results.append(foodRow({ name: r.title, meta: 'no nutrition data for its ingredients yet', tag: 'recipe' }, () => {}));
          }
        }
        if (!matches.length) results.append(el('div', { class: 'form-hint' }, 'Nothing in your foods — try an online search below.'));
      }

      async function searchOnline(which) {
        const q = input.value.trim();
        if (!q) return;
        onlineEl.innerHTML = '';
        onlineEl.append(el('div', { class: 'spinner', style: 'margin:14px auto' }));
        const res = which === 'off' ? await searchProducts(q) : await searchUsda(q);
        onlineEl.innerHTML = '';
        if (res.status === 'ratelimited') {
          onlineEl.append(el('div', { class: 'form-hint form-warn' }, 'USDA demo key is rate-limited right now — add your own free key under Daily targets.'));
          return;
        }
        if (res.status !== 'ok') {
          onlineEl.append(el('div', { class: 'form-hint form-warn' }, 'Search failed — check your connection.'));
          return;
        }
        const foods = which === 'off'
          ? (res.products || []).filter((p) => p.nutrition).map((p) => ({ name: p.brand ? `${p.name} (${p.brand})` : p.name, nutrition: p.nutrition }))
          : res.foods;
        if (!foods.length) {
          onlineEl.append(el('div', { class: 'form-hint' }, 'No results with nutrition data.'));
          return;
        }
        onlineEl.append(el('div', { class: 'form-label' }, which === 'off' ? 'Open Food Facts' : 'USDA FoodData Central'));
        for (const f of foods.slice(0, 6)) {
          onlineEl.append(foodRow({ name: f.name, meta: per100Meta(f.nutrition) },
            () => pick({ name: f.name, kind: 'per100', base: { per100: f.nutrition } })));
        }
      }

      input.addEventListener('input', debounce(renderLocal, 150));

      body.append(
        el('div', { class: 'search', style: 'margin-top:6px' }, el('span', { html: SEARCH_ICON }), input),
        results,
        el('div', { class: 'addopts', style: 'margin-top:14px' },
          el('button', { class: 'btn-scan', onclick: () => searchOnline('off') }, 'Open Food Facts'),
          el('button', { class: 'btn-scan', onclick: () => searchOnline('usda') }, 'USDA')
        ),
        onlineEl,
        el('button', { class: 'disclosure', onclick: () => { api.close(); openManualFood(date, meal, input.value.trim()); } }, 'Enter nutrition manually')
      );
      renderLocal();
      setTimeout(() => input.focus(), 120);
    },
  });
}

/* ── Portion (review-before-log) ── */

function openPortionSheet({ date, meal, name, kind, base, initialAmount, initialUnit, existing }) {
  if (existing) {
    ({ name, kind, base } = existing);
    if (existing.kind === 'fixed') { openManualFood(date, meal, name, existing); return; }
    initialAmount = existing.amount;
    initialUnit = existing.unit;
  }
  let amount = initialAmount ?? (kind === 'serve' ? 1 : 100);
  let unit = initialUnit || (kind === 'serve' ? 'serve' : (base.per100.basis === 'ml' ? 'ml' : 'g'));

  openSheet({
    title: name,
    build(body, api) {
      const preview = el('div', { class: 'macro-preview' });
      const amtInput = el('input', { class: 'qty-input', type: 'text', inputmode: 'decimal', value: String(amount) });

      const computed = () => {
        const a = parseFloat(String(amtInput.value).replace(',', '.'));
        const amt = Number.isFinite(a) && a > 0 ? a : amount;
        return kind === 'serve' ? scaleServes(base.perServe, amt) : scaleNutrition(base.per100, amt);
      };
      const updatePreview = () => {
        const n = computed();
        preview.textContent = `${n.kcal ?? 0} kcal · P ${fmtG(n.protein)} · C ${fmtG(n.carbs)} · F ${fmtG(n.fat)}`;
      };
      amtInput.addEventListener('input', updatePreview);

      const step = kind === 'serve' ? 0.5 : 25;
      const stepper = el('div', { class: 'stepper' },
        el('button', { onclick: () => { const v = Math.max(step, (parseFloat(amtInput.value) || amount) - step); amtInput.value = String(Math.round(v * 100) / 100); updatePreview(); } }, '−'),
        amtInput,
        el('button', { onclick: () => { const v = (parseFloat(amtInput.value) || amount) + step; amtInput.value = String(Math.round(v * 100) / 100); updatePreview(); } }, '+')
      );

      let unitChips = null;
      if (kind === 'per100') {
        unitChips = el('div', { class: 'chip-wrap' });
        for (const u of ['g', 'ml']) {
          unitChips.append(el('button', {
            class: `chip${unit === u ? ' active' : ''}`,
            onclick: (e) => { unit = u; for (const c of unitChips.children) c.classList.remove('active'); e.currentTarget.classList.add('active'); },
          }, u));
        }
      }

      body.append(
        el('div', { class: 'form-label' }, kind === 'serve' ? 'Serves' : 'Amount'),
        el('div', { class: 'qty-row' }, stepper, unitChips),
        base.note ? el('div', { class: 'form-hint' }, `Estimate based on ${base.note}`) : null,
        preview,
        el('div', { class: 'sheet-actions' },
          existing ? el('button', {
            class: 'btn btn-danger',
            onclick: async () => {
              await dbDel('nutritionLogs', existing.id);
              api.close();
              render();
              toast(`Removed ${name}`, { action: 'Undo', onAction: async () => { await dbPut('nutritionLogs', existing); render(); } });
            },
          }, 'Delete') : null,
          el('button', {
            class: 'btn btn-primary',
            onclick: async () => {
              const a = parseFloat(String(amtInput.value).replace(',', '.'));
              const amt = Number.isFinite(a) && a > 0 ? Math.round(a * 100) / 100 : amount;
              await dbPut('nutritionLogs', {
                id: existing?.id || uuid(),
                date, meal, name, kind, base,
                amount: amt,
                unit: kind === 'serve' ? 'serve' : unit,
                nutrients: computed(),
                createdAt: existing?.createdAt || Date.now(),
              });
              api.close();
              if (!existing) toast(`Logged ${name}`);
              render();
            },
          }, existing ? 'Save' : 'Add')
        )
      );
      updatePreview();
    },
  });
}

/* ── Manual entry ── */

function openManualFood(date, meal, prefillName = '', existing = null) {
  openSheet({
    title: existing ? 'Edit entry' : 'Manual entry',
    build(body, api) {
      const nameInput = el('input', { class: 'field-input', type: 'text', autocapitalize: 'words', placeholder: 'e.g. Café banana bread', value: existing?.name || prefillName });
      const inputs = {};
      const grid = el('div', { class: 'nutri-grid' });
      for (const f of NUTRIENTS) {
        const inp = el('input', { type: 'text', inputmode: 'decimal', placeholder: '—' });
        inp.value = existing?.nutrients?.[f.id] != null ? String(existing.nutrients[f.id]) : '';
        inputs[f.id] = inp;
        grid.append(el('div', { class: 'nutri-cell' }, el('label', {}, `${f.label} (${f.unit})`), inp));
      }
      body.append(
        el('div', { class: 'form-label' }, 'Name'),
        nameInput,
        el('div', { class: 'form-label' }, 'Nutrition for this portion'),
        grid,
        el('div', { class: 'sheet-actions' },
          existing ? el('button', {
            class: 'btn btn-danger',
            onclick: async () => {
              await dbDel('nutritionLogs', existing.id);
              api.close();
              render();
              toast(`Removed ${existing.name}`, { action: 'Undo', onAction: async () => { await dbPut('nutritionLogs', existing); render(); } });
            },
          }, 'Delete') : null,
          el('button', {
            class: 'btn btn-primary',
            onclick: async () => {
              const name = nameInput.value.trim();
              if (!name) { nameInput.classList.add('field-error'); nameInput.focus(); setTimeout(() => nameInput.classList.remove('field-error'), 1200); return; }
              const nutrients = {};
              for (const id of NUTRIENT_IDS) {
                const n = parseFloat(String(inputs[id].value).replace(',', '.'));
                nutrients[id] = Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : null;
              }
              if (nutrients.kcal != null) nutrients.kcal = Math.round(nutrients.kcal);
              await dbPut('nutritionLogs', {
                id: existing?.id || uuid(),
                date: existing?.date || date, meal: existing?.meal || meal,
                name: name.charAt(0).toUpperCase() + name.slice(1),
                kind: 'fixed', base: null, amount: 1, unit: 'portion',
                nutrients,
                createdAt: existing?.createdAt || Date.now(),
              });
              api.close();
              render();
            },
          }, existing ? 'Save' : 'Add')
        )
      );
      if (!existing) setTimeout(() => nameInput.focus(), 120);
    },
  });
}
