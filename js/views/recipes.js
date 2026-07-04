/* Recipes tab: craving search, pantry-first / use-it-up ranking, list,
   detail view, and entry points for add/paste/cook. */

import { dbAll, dbGet, dbPut } from '../db.js';
import { el, openSheet, debounce } from '../ui.js';
import { ingredientUnitLabel } from '../units.js';
import { matchPantry } from '../match.js';
import { analyzeRecipe, preferenceScore, urgencyScore, cravingScore } from '../recommend.js';
import { recipeCost, fmtMoney } from '../cost.js';
import { openRecipeEditor, openRecipePaste } from './recipeedit.js';
import { openCookMode } from './cookmode.js';

const BOOK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>';
const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.8-3.8"/></svg>';
const X_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const CLIPBOARD_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="4.5" width="13" height="17" rx="2.5"/><path d="M9 4.5a3 3 0 0 1 6 0M9 11h6M9 15h4"/></svg>';
const PENCIL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3.5l3.5 3.5L8 19.5 4 20l.5-4L17 3.5z"/></svg>';
const HEART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20.5s-7.5-4.7-7.5-10A4.4 4.4 0 0 1 9 6a4.6 4.6 0 0 1 3 1.5A4.6 4.6 0 0 1 15 6a4.4 4.4 0 0 1 4.5 4.5c0 5.3-7.5 10-7.5 10z"/></svg>';
const HEART_FILL = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 20.5s-7.5-4.7-7.5-10A4.4 4.4 0 0 1 9 6a4.6 4.6 0 0 1 3 1.5A4.6 4.6 0 0 1 15 6a4.4 4.4 0 0 1 4.5 4.5c0 5.3-7.5 10-7.5 10z"/></svg>';

const MODES = [
  { id: 'az',     label: 'A–Z' },
  { id: 'pantry', label: 'Pantry first' },
  { id: 'useup',  label: 'Use it up' },
];

let recipes = [];
let pantry = [];
let analyses = new Map(); // recipe.id → analyzeRecipe result
let query = '';
let mode = localStorage.getItem('larder.recipes.mode') || 'pantry';
let listEl = null;
let ctxRef = null;

export const recipesView = {
  async mount(container, ctx) {
    ctxRef = ctx;
    // Re-read on every mount — other views (e.g. the Insights expiry nudge)
    // can change the stored mode before navigating here.
    mode = localStorage.getItem('larder.recipes.mode') || 'pantry';
    container.append(buildToolbar());
    listEl = el('div', { class: 'list-area' });
    container.append(listEl);
    await refresh();
  },
  onFab() {
    openAddChooser();
  },
};

async function refresh() {
  [recipes, pantry] = await Promise.all([dbAll('recipes'), dbAll('pantry')]);
  pantry = pantry.filter((p) => p.quantity.amount > 0);
  analyses = new Map(recipes.map((r) => [r.id, analyzeRecipe(r, pantry)]));
  if (ctxRef) {
    const liked = recipes.filter((r) => r.liked).length;
    ctxRef.setSubtitle(recipes.length ? `${recipes.length} recipe${recipes.length === 1 ? '' : 's'}${liked ? ` · ${liked} liked` : ''}` : '');
  }
  renderList();
}

/* ── Toolbar: craving search + ranking mode ── */

function buildToolbar() {
  const clearBtn = el('button', { class: 'search-clear', 'aria-label': 'Clear search', html: X_ICON, hidden: true });
  const input = el('input', {
    type: 'search', placeholder: 'What are you craving?', autocomplete: 'off',
    oninput: debounce(() => {
      query = input.value;
      clearBtn.hidden = !query;
      renderList();
    }, 140),
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    query = '';
    clearBtn.hidden = true;
    renderList();
    input.focus();
  });

  const seg = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Ranking' });
  for (const m of MODES) {
    seg.append(el('button', {
      'aria-pressed': String(m.id === mode),
      onclick: (e) => {
        mode = m.id;
        localStorage.setItem('larder.recipes.mode', mode);
        for (const b of seg.children) b.setAttribute('aria-pressed', 'false');
        e.currentTarget.setAttribute('aria-pressed', 'true');
        renderList();
      },
    }, m.label));
  }

  return el('div', { class: 'toolbar' },
    el('div', { class: 'search' }, el('span', { html: SEARCH_ICON }), input, clearBtn),
    seg
  );
}

/* ── Ranking ── */

function rank(list) {
  const byTitle = (a, b) => a.titleLower.localeCompare(b.titleLower);
  const q = query.trim();
  if (q) {
    const scored = list
      .map((r) => ({ r, s: cravingScore(r, q) }))
      .filter((x) => x.s > 0);
    scored.sort((a, b) => b.s - a.s || preferenceScore(b.r) - preferenceScore(a.r) || byTitle(a.r, b.r));
    return scored.map((x) => x.r);
  }
  const sorted = [...list];
  if (mode === 'pantry') {
    sorted.sort((a, b) =>
      analyses.get(a.id).missing.length - analyses.get(b.id).missing.length
      || preferenceScore(b) - preferenceScore(a)
      || byTitle(a, b));
  } else if (mode === 'useup') {
    sorted.sort((a, b) =>
      urgencyScore(analyses.get(b.id).expiring) - urgencyScore(analyses.get(a.id).expiring)
      || analyses.get(a.id).missing.length - analyses.get(b.id).missing.length
      || byTitle(a, b));
  } else {
    sorted.sort(byTitle);
  }
  return sorted;
}

const fmtDays = (d) => (d < 0 ? 'expired' : d === 0 ? 'today' : d === 1 ? '1 day' : `${d} days`);

function metaFor(recipe) {
  const a = analyses.get(recipe.id);
  if (mode === 'useup' && !query.trim()) {
    if (!a.expiring.length) return 'uses nothing expiring';
    const names = a.expiring.slice(0, 2).map((e) => `${e.name} (${fmtDays(e.days)})`);
    const more = a.expiring.length > 2 ? ` +${a.expiring.length - 2}` : '';
    return `uses ${names.join(', ')}${more}`;
  }
  if (mode === 'pantry' || query.trim()) {
    if (!a.missing.length) return `have ${a.have}/${a.total} · nothing missing`;
    const shown = a.missing.slice(0, 2).join(', ');
    const more = a.missing.length > 2 ? ` +${a.missing.length - 2}` : '';
    return `have ${a.have}/${a.total} · need ${shown}${more}`;
  }
  const bits = [`serves ${recipe.servings}`, `${recipe.ingredients.length} ingredients`];
  if (recipe.timesCooked) bits.push(`cooked ×${recipe.timesCooked}`);
  return bits.join(' · ');
}

function matchChip(recipe) {
  if (mode === 'az' && !query.trim()) return null;
  const a = analyses.get(recipe.id);
  const cls = a.missing.length === 0 ? ' ok' : a.missing.length <= 2 ? ' near' : '';
  return el('span', { class: `match-chip${cls}` }, `${a.have}/${a.total}`);
}

/* ── List ── */

function openAddChooser() {
  openSheet({
    title: 'New recipe',
    build(body, api) {
      body.append(
        el('div', { class: 'addopts', style: 'flex-direction:column' },
          el('button', { class: 'btn-scan', onclick: () => { api.close(); openRecipePaste({ onSaved: refresh }); } },
            el('span', { html: CLIPBOARD_ICON }), 'Paste text from Instagram / web'),
          el('button', { class: 'btn-scan', onclick: () => { api.close(); openRecipeEditor({}, { onSaved: refresh }); } },
            el('span', { html: PENCIL_ICON }), 'Write it myself')
        )
      );
    },
  });
}

function renderList() {
  if (!listEl) return;
  listEl.innerHTML = '';

  if (!recipes.length) {
    listEl.append(
      el('div', { class: 'empty' },
        el('div', { class: 'empty-icon', html: BOOK_ICON }),
        el('h3', {}, 'No recipes yet'),
        el('p', {}, 'Write one in, or paste the text of a recipe from Instagram or the web and Larder will structure it for you.'),
        el('button', { class: 'btn btn-primary', onclick: openAddChooser }, 'Add a recipe')
      )
    );
    return;
  }

  const ranked = rank(recipes);
  if (!ranked.length) {
    listEl.append(
      el('div', { class: 'empty' },
        el('h3', {}, 'No matches'),
        el('p', {}, `Nothing matches “${query.trim()}” — try different words, or add a recipe like that.`)
      )
    );
    return;
  }

  const card = el('div', { class: 'card' });
  for (const r of ranked) {
    const side = [];
    const chip = matchChip(r);
    if (chip) side.push(chip);
    if (r.liked) side.push(el('span', { class: 'heart-mini', html: HEART_FILL }));
    card.append(
      el('button', { class: 'row', onclick: () => openRecipeDetail(r.id) },
        el('div', { class: 'row-main' },
          el('div', { class: 'row-name' }, r.title),
          el('div', { class: 'row-meta' }, metaFor(r))
        ),
        side.length ? el('div', { class: 'row-side row-side-h' }, ...side) : null
      )
    );
  }
  listEl.append(card);
}

/* ── Detail ── */

async function openRecipeDetail(id) {
  const recipe = await dbGet('recipes', id);
  if (!recipe) return;
  const freshPantry = (await dbAll('pantry')).filter((p) => p.quantity.amount > 0);

  const heartBtn = el('button', { class: `icon-btn heart${recipe.liked ? ' on' : ''}`, 'aria-label': 'Like recipe', html: recipe.liked ? HEART_FILL : HEART });
  heartBtn.addEventListener('click', async () => {
    recipe.liked = !recipe.liked;
    recipe.updatedAt = Date.now();
    await dbPut('recipes', recipe);
    heartBtn.classList.toggle('on', recipe.liked);
    heartBtn.innerHTML = recipe.liked ? HEART_FILL : HEART;
    refresh();
  });

  const body = el('div', { class: 'o-list' });
  const overlay = el('div', { class: 'page' },
    el('div', { class: 'o-head' },
      el('button', { class: 'o-cancel', onclick: close }, 'Back'),
      el('div', { class: 'o-title', style: 'flex:1' }),
      heartBtn,
      el('button', {
        class: 'icon-btn', 'aria-label': 'Edit recipe', html: PENCIL_ICON,
        onclick: () => openRecipeEditor(recipe, {
          onSaved: (updated) => { Object.assign(recipe, updated); renderBody(); refresh(); },
          onDeleted: () => { close(); refresh(); },
        }),
      })
    ),
    body,
    el('div', { class: 'o-foot' },
      el('button', { class: 'btn btn-primary', onclick: () => openCookMode(recipe, { onCooked: () => { close(); refresh(); } }) }, 'Cook this')
    )
  );

  function close() {
    overlay.classList.remove('open');
    setTimeout(() => overlay.remove(), 360);
  }

  function renderBody() {
    body.innerHTML = '';
    const meta = [`Serves ${recipe.servings}`];
    if (recipe.timesCooked) meta.push(`cooked ×${recipe.timesCooked}`);
    const cost = recipeCost(recipe, freshPantry);
    if (cost.perServe != null) meta.push(`~${fmtMoney(cost.perServe)}/serve${cost.known < cost.count ? ` (${cost.known} of ${cost.count} priced)` : ''}`);
    if (recipe.source === 'paste') meta.push('from paste');

    const ingCard = el('div', { class: 'card', style: 'margin-top:8px' });
    for (const ing of recipe.ingredients) {
      const have = matchPantry(ing.name, freshPantry);
      const bits = [];
      if (ing.amount != null) bits.push(String(Math.round(ing.amount * 100) / 100));
      if (ing.unit) bits.push(ingredientUnitLabel(ing.unit));
      ingCard.append(
        el('div', { class: 'r-ing' },
          el('span', { class: `have-dot${have ? ' on' : ''}`, title: have ? 'In your pantry' : 'Not in pantry' }),
          el('span', { class: 'r-ing-amt' }, bits.join(' ')),
          el('span', { class: 'r-ing-name' }, ing.name)
        )
      );
    }

    body.append(
      el('h1', { class: 'r-title' }, recipe.title),
      el('div', { class: 'r-meta' }, meta.join(' · ')),
      recipe.sourceUrl ? el('a', { class: 'r-source', href: recipe.sourceUrl, target: '_blank', rel: 'noopener' }, 'Source ↗') : null,
      el('div', { class: 'form-label' }, 'Ingredients'),
      ingCard,
      el('div', { class: 'form-label' }, 'Steps'),
      el('div', { class: 'card r-steps' },
        ...recipe.steps.map((s, i) =>
          el('div', { class: 'r-step' },
            el('span', { class: 'r-step-num' }, String(i + 1)),
            el('span', { class: 'r-step-text' }, s)))
      )
    );
  }

  renderBody();
  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
}
