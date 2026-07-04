/* Shared item form used by quick add, edit, and the scan/import review screens.
   Every field is editable — captured data is never trusted silently. */

import { el, todayISO } from './ui.js';
import { UNITS, unitById, formatQty, CATEGORIES, parseQuick } from './units.js';

const CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

export const NUTRIENTS = [
  { id: 'kcal',    label: 'Energy',   unit: 'kcal' },
  { id: 'protein', label: 'Protein',  unit: 'g' },
  { id: 'carbs',   label: 'Carbs',    unit: 'g' },
  { id: 'sugars',  label: 'Sugars',   unit: 'g' },
  { id: 'fat',     label: 'Fat',      unit: 'g' },
  { id: 'satfat',  label: 'Sat. fat', unit: 'g' },
  { id: 'fiber',   label: 'Fibre',    unit: 'g' },
  { id: 'sodium',  label: 'Sodium',   unit: 'mg' },
];

const EXPIRY_PRESETS = [
  { label: 'None', value: null },
  { label: '3 days', value: 3 },
  { label: '1 week', value: 7 },
  { label: '2 weeks', value: 14 },
  { label: 'Date…', value: 'custom' },
];

export function fmtNum(n) {
  return String(Math.round(n * 100) / 100);
}

export function parseNum(text) {
  const n = parseFloat(String(text).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

// Nutrition values may legitimately be 0 (e.g. 0 g fat).
function parseNutriNum(text) {
  if (String(text).trim() === '') return null;
  const n = parseFloat(String(text).replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : null;
}

export function buildItemForm(initial = {}, opts = {}) {
  const quickParse = !!opts.quickParse;
  const showNutrition = !!opts.showNutrition;
  const state = {
    qty: initial.quantity?.amount ?? 1,
    unit: initial.quantity?.unit ?? 'ea',
    expiry: initial.expiryDate ?? null,
    category: initial.category ?? null,
  };
  // Once the user touches qty/unit, quick-add parsing stops overriding them.
  let qtyTouched = !quickParse;

  const nameInput = el('input', {
    class: 'field-input', type: 'text', autocomplete: 'off', autocapitalize: 'words',
    placeholder: quickParse ? 'e.g. Grapes 500g' : 'Name',
    value: initial.name || '',
  });
  const hint = el('div', { class: 'form-hint' });

  const qtyInput = el('input', { class: 'qty-input', type: 'text', inputmode: 'decimal', value: fmtNum(state.qty) });
  const step = () => unitById(state.unit)?.step || 1;
  const setQty = (v) => {
    state.qty = Math.round(v * 100) / 100;
    qtyInput.value = fmtNum(state.qty);
  };
  qtyInput.addEventListener('input', () => { qtyTouched = true; });
  qtyInput.addEventListener('blur', () => {
    const v = parseNum(qtyInput.value);
    setQty(v ?? state.qty);
  });

  const stepper = el('div', { class: 'stepper' },
    el('button', { 'aria-label': 'Decrease quantity', onclick: () => { qtyTouched = true; setQty(Math.max(step(), (parseNum(qtyInput.value) ?? state.qty) - step())); } }, '−'),
    qtyInput,
    el('button', { 'aria-label': 'Increase quantity', onclick: () => { qtyTouched = true; setQty((parseNum(qtyInput.value) ?? state.qty) + step()); } }, '+')
  );

  const unitChips = el('div', { class: 'chip-row' });
  function renderUnitChips() {
    unitChips.innerHTML = '';
    for (const u of UNITS) {
      unitChips.append(el('button', {
        class: `chip${state.unit === u.id ? ' active' : ''}`,
        onclick: () => { qtyTouched = true; state.unit = u.id; renderUnitChips(); },
      }, u.label));
    }
  }
  renderUnitChips();

  // Expiry
  let expirySel = state.expiry ? 'custom' : null;
  const dateInput = el('input', { class: 'field-input date-input', type: 'date', value: state.expiry || '', hidden: !state.expiry });
  const expiryChips = el('div', { class: 'chip-row' });
  function renderExpiryChips() {
    expiryChips.innerHTML = '';
    for (const preset of EXPIRY_PRESETS) {
      expiryChips.append(el('button', {
        class: `chip${expirySel === preset.value ? ' active' : ''}`,
        onclick: () => {
          expirySel = preset.value;
          dateInput.hidden = preset.value !== 'custom';
          if (preset.value === 'custom' && !dateInput.value) dateInput.value = todayISO(7);
          renderExpiryChips();
        },
      }, preset.label));
    }
  }
  renderExpiryChips();

  // Details (category + notes) behind a disclosure
  const catChips = el('div', { class: 'chip-wrap' });
  function renderCatChips() {
    catChips.innerHTML = '';
    for (const cat of CATEGORIES) {
      catChips.append(el('button', {
        class: `chip${state.category === cat.id ? ' active' : ''}`,
        onclick: () => {
          state.category = state.category === cat.id ? null : cat.id;
          renderCatChips();
        },
      }, cat.label));
    }
  }
  renderCatChips();

  const notesInput = el('textarea', { class: 'field-input', rows: '2', placeholder: 'Notes (optional)' });
  notesInput.value = initial.notes || '';

  // Price paid + staple/restock settings (feed Phase 6 costing & restocking)
  const priceInput = el('input', { class: 'field-input', type: 'text', inputmode: 'decimal', placeholder: 'e.g. 4.50' });
  priceInput.value = initial.price != null ? String(initial.price) : '';
  let isStaple = !!initial.isStaple;
  const lowInput = el('input', { class: 'field-input ing-amt', type: 'text', inputmode: 'decimal', placeholder: '0' });
  lowInput.value = initial.lowAt != null ? String(initial.lowAt) : '';
  const lowUnitEl = el('span', { class: 'd-unit' }, unitById(state.unit)?.label || state.unit);
  const lowWrap = el('div', { class: 'staple-low', hidden: !isStaple },
    el('span', { class: 'staple-low-label' }, 'Restock when below'), lowInput, lowUnitEl);
  const stapleChip = el('button', {
    class: `chip${isStaple ? ' active' : ''}`,
    onclick: () => {
      isStaple = !isStaple;
      stapleChip.classList.toggle('active', isStaple);
      lowWrap.hidden = !isStaple;
    },
  }, 'Staple — keep stocked');

  const detailsWrap = el('div', { hidden: true },
    el('div', { class: 'form-label' }, 'Category'),
    catChips,
    el('div', { class: 'form-label' }, 'Notes'),
    notesInput,
    el('div', { class: 'form-label' }, 'Price paid ($)'),
    priceInput,
    el('div', { class: 'form-label' }, 'Restock'),
    el('div', { class: 'chip-wrap' }, stapleChip),
    lowWrap
  );
  const detailsBtn = el('button', { class: 'disclosure' }, 'Add details', el('span', { html: CHEVRON }));
  detailsBtn.addEventListener('click', () => {
    const expanded = detailsWrap.hidden;
    detailsWrap.hidden = !expanded;
    detailsBtn.classList.toggle('expanded', expanded);
    detailsBtn.firstChild.textContent = expanded ? 'Hide details' : 'Add details';
  });
  if (initial.category || initial.notes || initial.price != null || initial.isStaple) detailsBtn.click();

  // Nutrition per 100 g/ml, behind its own disclosure
  let nutriBtn = null;
  let nutriWrap = null;
  let renderBasisChipsRef = null;
  const nutriInputs = {};
  let basis = initial.nutrition?.basis || (['ml', 'l'].includes(initial.quantity?.unit) ? 'ml' : 'g');
  function nutriLabelText() {
    const kcal = parseNutriNum(nutriInputs.kcal?.value ?? '');
    const any = NUTRIENTS.some((f) => parseNutriNum(nutriInputs[f.id]?.value ?? '') != null);
    return any ? `Nutrition · ${kcal != null ? `${kcal} kcal` : 'saved'} per 100 ${basis}` : 'Add nutrition';
  }
  if (showNutrition) {
    const grid = el('div', { class: 'nutri-grid' });
    for (const f of NUTRIENTS) {
      const input = el('input', { type: 'text', inputmode: 'decimal', placeholder: '—', 'aria-label': f.label });
      const v = initial.nutrition?.[f.id];
      input.value = v != null ? String(v) : '';
      nutriInputs[f.id] = input;
      grid.append(el('div', { class: 'nutri-cell' }, el('label', {}, `${f.label} (${f.unit})`), input));
    }

    const basisChips = el('div', { class: 'chip-wrap' });
    function renderBasisChips() {
      basisChips.innerHTML = '';
      for (const b of ['g', 'ml']) {
        basisChips.append(el('button', {
          class: `chip${basis === b ? ' active' : ''}`,
          onclick: () => { basis = b; renderBasisChips(); nutriBtn.firstChild.textContent = nutriLabelText(); },
        }, `per 100 ${b}`));
      }
    }
    renderBasisChipsRef = renderBasisChips;
    renderBasisChips();

    nutriWrap = el('div', { hidden: true },
      el('div', { class: 'form-label' }, 'Nutrition'),
      basisChips,
      grid
    );
    nutriBtn = el('button', { class: 'disclosure' }, nutriLabelText(), el('span', { html: CHEVRON }));
    nutriBtn.addEventListener('click', () => {
      const expanded = nutriWrap.hidden;
      nutriWrap.hidden = !expanded;
      nutriBtn.classList.toggle('expanded', expanded);
    });
    for (const f of NUTRIENTS) {
      nutriInputs[f.id].addEventListener('input', () => { nutriBtn.firstChild.textContent = nutriLabelText(); });
    }
  }

  if (quickParse) {
    nameInput.addEventListener('input', () => {
      const parsed = parseQuick(nameInput.value);
      if (!qtyTouched && parsed.qty != null) {
        setQty(parsed.qty);
        if (parsed.unit) { state.unit = parsed.unit; renderUnitChips(); }
      }
      if (parsed.qty != null && parsed.name) {
        const qty = qtyTouched ? (parseNum(qtyInput.value) ?? state.qty) : parsed.qty;
        hint.textContent = `Adding “${parsed.name}” — ${formatQty(qty, state.unit)}`;
      } else {
        hint.textContent = '';
      }
    });
  }

  const root = el('div', {},
    el('div', { class: 'form-label' }, 'Item'),
    nameInput,
    quickParse ? hint : null,
    el('div', { class: 'form-label' }, 'Quantity'),
    el('div', { class: 'qty-row' }, stepper),
    el('div', { style: 'height:10px' }),
    unitChips,
    el('div', { class: 'form-label' }, 'Expiry'),
    expiryChips,
    dateInput,
    detailsBtn,
    detailsWrap,
    nutriBtn,
    nutriWrap
  );

  return {
    root,
    focusName() { nameInput.focus(); },
    setNutrition(n) {
      if (!showNutrition || !n) return;
      basis = n.basis || basis;
      if (renderBasisChipsRef) renderBasisChipsRef();
      for (const f of NUTRIENTS) nutriInputs[f.id].value = n[f.id] != null ? String(n[f.id]) : '';
      nutriBtn.firstChild.textContent = nutriLabelText();
    },
    flagName() {
      nameInput.classList.add('field-error');
      nameInput.focus();
      setTimeout(() => nameInput.classList.remove('field-error'), 1200);
    },
    read() {
      let name = nameInput.value.trim();
      if (quickParse) {
        const parsed = parseQuick(nameInput.value);
        if (parsed.name) name = parsed.name;
      }
      if (name) name = name.charAt(0).toUpperCase() + name.slice(1);
      let expiry = null;
      if (typeof expirySel === 'number') expiry = todayISO(expirySel);
      else if (expirySel === 'custom') expiry = dateInput.value || null;

      let nutrition = initial.nutrition ?? null;
      if (showNutrition) {
        const values = {};
        let any = false;
        for (const f of NUTRIENTS) {
          values[f.id] = parseNutriNum(nutriInputs[f.id].value);
          if (values[f.id] != null) any = true;
        }
        nutrition = any ? { per: 100, basis, ...values } : null;
      }
      const money = (txt) => {
        if (String(txt).trim() === '') return null;
        const n = parseFloat(String(txt).replace(',', '.').replace('$', ''));
        return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
      };
      return {
        name,
        qty: parseNum(qtyInput.value) ?? state.qty ?? 1,
        unit: state.unit,
        expiry,
        category: state.category,
        notes: notesInput.value.trim(),
        nutrition,
        price: money(priceInput.value),
        isStaple,
        lowAt: isStaple ? money(lowInput.value) : null,
      };
    },
    reset() {
      nameInput.value = '';
      hint.textContent = '';
      qtyTouched = false;
      setQty(1);
      state.unit = 'ea';
      renderUnitChips();
      expirySel = null;
      dateInput.hidden = true;
      dateInput.value = '';
      renderExpiryChips();
      state.category = null;
      renderCatChips();
      notesInput.value = '';
      priceInput.value = '';
      isStaple = false;
      stapleChip.classList.remove('active');
      lowWrap.hidden = true;
      lowInput.value = '';
      if (showNutrition) for (const f of NUTRIENTS) nutriInputs[f.id].value = '';
    },
  };
}
