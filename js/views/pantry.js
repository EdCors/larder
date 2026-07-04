/* Pantry view: quick add, barcode scanning, edit/delete, search, sort. */

import { dbAll, dbPut, dbDel, uuid } from '../db.js';
import { $, el, debounce, openSheet, confirmSheet, toast, daysUntil, fmtDateShort, expiryInfo } from '../ui.js';
import { exportBackup, validateBackup, summarizeBackup, applyBackup } from '../backup.js';
import { formatQty, catById } from '../units.js';
import { buildItemForm } from '../itemform.js';
import { openScanner } from '../scanner.js';
import { startBarcodeReview, openManualBarcode } from './review.js';
import { openOrderPaste } from './orderreview.js';
import { openWasteSheet } from './insights.js';

const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.8-3.8"/></svg>';
const X_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const JAR_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="7.5" y="3" width="9" height="3" rx="1.5"/><rect x="5.5" y="8.5" width="13" height="12.5" rx="3"/></svg>';
const BARCODE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M3 6v12M7 6v12M10.5 6v12M13.5 6v8M17 6v12M21 6v12M13.5 17.5v.5"/></svg>';
const CLIPBOARD_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="4.5" width="13" height="17" rx="2.5"/><path d="M9 4.5a3 3 0 0 1 6 0M9 11h6M9 15h4"/></svg>';

const SORTS = [
  { id: 'name',   label: 'Name' },
  { id: 'expiry', label: 'Expiry' },
  { id: 'recent', label: 'Recent' },
];

let items = [];
let query = '';
let sort = localStorage.getItem('larder.sort') || 'name';
let listEl = null;
let ctxRef = null;

const DOTS_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="12" cy="19" r="1.9"/></svg>';

export const pantryView = {
  async mount(container, ctx) {
    ctxRef = ctx;
    ctx.setActions(el('button', {
      class: 'icon-btn', 'aria-label': 'Pantry options', html: DOTS_ICON,
      onclick: openPantryMenu,
    }));
    container.append(buildToolbar());
    listEl = el('div', { class: 'list-area' });
    container.append(listEl);
    await refresh();
  },
  openQuickAdd() {
    openQuickAddSheet();
  },
  onFab() {
    openQuickAddSheet();
  },
};

async function refresh() {
  items = await dbAll('pantry');
  updateSubtitle();
  renderList();
}

function updateSubtitle() {
  if (!ctxRef) return;
  if (!items.length) {
    ctxRef.setSubtitle('');
    return;
  }
  const expired = items.filter((i) => i.expiryDate && daysUntil(i.expiryDate) < 0).length;
  const soon = items.filter((i) => {
    if (!i.expiryDate) return false;
    const d = daysUntil(i.expiryDate);
    return d >= 0 && d <= 3;
  }).length;
  let extra = '';
  if (expired) extra = ` · ${expired} expired`;
  else if (soon) extra = ` · ${soon} expiring soon`;
  ctxRef.setSubtitle(`${items.length} item${items.length === 1 ? '' : 's'}${extra}`);
}

/* ── Overflow menu: backup, restore, bulk clean-ups ── */

const EXPORT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7.5 10.5L12 15l4.5-4.5M4.5 18.5h15"/></svg>';
const IMPORT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3M7.5 7.5L12 3l4.5 4.5M4.5 18.5h15"/></svg>';
const CLOCK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>';
const BIN_ICON2 = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13.5h9l1-13.5M10 11v6M14 11v6"/></svg>';

function menuRow({ icon, title, sub, danger, disabled, onclick }) {
  return el('button', { class: `menu-row${danger ? ' danger' : ''}`, disabled: !!disabled, onclick },
    el('span', { html: icon }),
    el('div', { class: 'menu-main' },
      el('div', { class: 'menu-title' }, title),
      sub ? el('div', { class: 'menu-sub' }, sub) : null
    )
  );
}

function openPantryMenu() {
  const expired = items.filter((i) => i.expiryDate && daysUntil(i.expiryDate) < 0);

  openSheet({
    title: 'Pantry options',
    build(body, api) {
      const fileInput = el('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
      fileInput.addEventListener('change', () => {
        const file = fileInput.files && fileInput.files[0];
        if (file) handleImportFile(file);
      });

      body.append(
        el('div', { class: 'card', style: 'margin-top:6px' },
          menuRow({
            icon: EXPORT_ICON,
            title: 'Export backup',
            sub: 'Save a file with all your Larder data',
            onclick: async () => {
              api.close();
              const result = await exportBackup();
              if (result !== 'cancelled') toast('Backup exported');
            },
          }),
          menuRow({
            icon: IMPORT_ICON,
            title: 'Import backup',
            sub: 'Restore from an exported file — replaces current data',
            onclick: () => fileInput.click(),
          }),
          menuRow({
            icon: CLOCK_ICON,
            title: 'Remove expired items',
            sub: expired.length
              ? `${expired.length} item${expired.length === 1 ? '' : 's'} past expiry`
              : 'Nothing is past its expiry date',
            disabled: !expired.length,
            onclick: () => {
              const names = expired.slice(0, 3).map((i) => i.name).join(', ') + (expired.length > 3 ? '…' : '');
              confirmSheet({
                title: 'Remove expired items',
                message: `This deletes ${expired.length} expired item${expired.length === 1 ? '' : 's'} from your pantry: ${names}`,
                confirmLabel: `Remove ${expired.length}`,
                onConfirm: async () => {
                  for (const item of expired) await dbDel('pantry', item.id);
                  await refresh();
                  toast(`Removed ${expired.length} expired item${expired.length === 1 ? '' : 's'}`, {
                    action: 'Undo',
                    onAction: async () => { for (const item of expired) await dbPut('pantry', item); await refresh(); },
                  });
                },
              });
            },
          }),
          menuRow({
            icon: BIN_ICON2,
            title: 'Clear entire pantry',
            sub: 'Recipes, plans and logs are kept',
            danger: true,
            disabled: !items.length,
            onclick: () => {
              const all = [...items];
              confirmSheet({
                title: 'Clear entire pantry',
                message: `This deletes all ${all.length} pantry items. Recipes, meal plans, nutrition and waste logs are not affected.`,
                confirmLabel: 'Delete all',
                onConfirm: async () => {
                  for (const item of all) await dbDel('pantry', item.id);
                  await refresh();
                  toast(`Cleared ${all.length} items`, {
                    action: 'Undo',
                    onAction: async () => { for (const item of all) await dbPut('pantry', item); await refresh(); },
                  });
                },
              });
            },
          })
        ),
        fileInput
      );
    },
  });
}

async function handleImportFile(file) {
  let backup = null;
  try {
    backup = JSON.parse(await file.text());
  } catch {
    toast('That file isn’t valid JSON');
    return;
  }
  if (!validateBackup(backup)) {
    toast('That doesn’t look like a Larder backup file');
    return;
  }
  const s = summarizeBackup(backup);
  const when = s.exportedAt ? new Date(s.exportedAt).toLocaleDateString() : 'unknown date';
  confirmSheet({
    title: 'Restore backup',
    message: `Backup from ${when}: ${s.pantry} pantry items, ${s.recipes} recipes, ${s.mealPlans} planned meals, ${s.shopping} shopping items, ${s.nutritionLogs} nutrition entries, ${s.wasteLog} waste entries. This replaces ALL current Larder data on this device.`,
    confirmLabel: 'Replace & restore',
    onConfirm: async () => {
      await applyBackup(backup);
      location.reload();
    },
  });
}

/* ── Scanning flow ── */

function openScannerFlow() {
  const toReview = (code) => startBarcodeReview(code, { onDone: refresh, onScanNext: openScannerFlow });
  openScanner({
    onCode: toReview,
    onManual: () => openManualBarcode({ onCode: toReview }),
  });
}

/* ── Toolbar (search + sort) ── */

function buildToolbar() {
  const clearBtn = el('button', { class: 'search-clear', 'aria-label': 'Clear search', html: X_ICON, hidden: true });
  const input = el('input', {
    type: 'search', placeholder: 'Search pantry', autocomplete: 'off',
    oninput: debounce(() => {
      query = input.value;
      clearBtn.hidden = !query;
      renderList();
    }, 120),
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    query = '';
    clearBtn.hidden = true;
    renderList();
    input.focus();
  });

  const seg = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Sort by' });
  for (const s of SORTS) {
    seg.append(el('button', {
      'aria-pressed': String(s.id === sort),
      onclick: (e) => {
        sort = s.id;
        localStorage.setItem('larder.sort', sort);
        for (const b of seg.children) b.setAttribute('aria-pressed', 'false');
        e.currentTarget.setAttribute('aria-pressed', 'true');
        renderList();
      },
    }, s.label));
  }

  return el('div', { class: 'toolbar' },
    el('div', { class: 'search' }, el('span', { html: SEARCH_ICON }), input, clearBtn),
    seg
  );
}

/* ── List rendering ── */

function sortItems(list) {
  const byName = (a, b) => a.nameLower.localeCompare(b.nameLower);
  if (sort === 'expiry') {
    return list.sort((a, b) => {
      const da = a.expiryDate ? daysUntil(a.expiryDate) : Infinity;
      const db = b.expiryDate ? daysUntil(b.expiryDate) : Infinity;
      return da - db || byName(a, b);
    });
  }
  if (sort === 'recent') return list.sort((a, b) => b.addedAt - a.addedAt || byName(a, b));
  return list.sort(byName);
}

function renderList() {
  if (!listEl) return;
  listEl.innerHTML = '';

  if (!items.length) {
    listEl.append(
      el('div', { class: 'empty' },
        el('div', { class: 'empty-icon', html: JAR_ICON }),
        el('h3', {}, 'Your pantry is empty'),
        el('p', {}, 'Add what you have on hand — quick add understands shorthand like “Grapes 500g”. You can also scan a barcode or paste an online order.'),
        el('button', { class: 'btn btn-primary', onclick: openQuickAddSheet }, 'Add your first item')
      )
    );
    return;
  }

  const q = query.trim().toLowerCase();
  const visible = sortItems(items.filter((item) => {
    if (!q) return true;
    const cat = item.category ? (catById(item.category)?.label || '') : '';
    return item.nameLower.includes(q)
      || cat.toLowerCase().includes(q)
      || (item.brand || '').toLowerCase().includes(q)
      || (item.notes || '').toLowerCase().includes(q);
  }));

  if (!visible.length) {
    listEl.append(
      el('div', { class: 'empty' },
        el('h3', {}, 'No matches'),
        el('p', {}, `Nothing in your pantry matches “${query.trim()}”.`)
      )
    );
    return;
  }

  const card = el('div', { class: 'card' });
  for (const item of visible) card.append(buildRow(item));
  listEl.append(card);
  listEl.append(el('div', { class: 'list-count' },
    q ? `${visible.length} of ${items.length} items` : `${items.length} item${items.length === 1 ? '' : 's'}`));
}

function buildRow(item) {
  const meta = [];
  if (item.brand) meta.push(item.brand);
  if (item.category) {
    const cat = catById(item.category);
    if (cat) {
      if (meta.length) meta.push('·');
      meta.push(el('span', { class: 'cat-dot', style: `background:${cat.color}` }));
      meta.push(cat.label);
    }
  }

  const side = [el('div', { class: 'row-qty' }, formatQty(item.quantity.amount, item.quantity.unit))];
  if (item.expiryDate) {
    const info = expiryInfo(item.expiryDate);
    side.push(el('span', { class: `chip-exp ${info.cls}` }, info.label));
  }

  return el('button', { class: 'row', onclick: () => openEditSheet(item) },
    el('div', { class: 'row-main' },
      el('div', { class: 'row-name' }, item.name),
      meta.length ? el('div', { class: 'row-meta' }, ...meta) : null
    ),
    el('div', { class: 'row-side' }, ...side)
  );
}

/* ── Quick add ── */

function openQuickAddSheet() {
  openSheet({
    title: 'Add to pantry',
    build(body, api) {
      const form = buildItemForm({}, { quickParse: true });

      async function commit() {
        const v = form.read();
        if (!v.name) {
          form.flagName();
          return false;
        }
        const item = {
          id: uuid(),
          name: v.name,
          nameLower: v.name.toLowerCase(),
          quantity: { amount: v.qty, unit: v.unit },
          category: v.category,
          expiryDate: v.expiry,
          notes: v.notes,
          barcode: null,
          brand: null,
          imageUrl: null,
          nutrition: null,
          price: v.price,
          priceQty: v.price != null ? { amount: v.qty, unit: v.unit } : null,
          isStaple: v.isStaple,
          lowAt: v.lowAt,
          source: 'manual',
          addedAt: Date.now(),
          updatedAt: Date.now(),
        };
        await dbPut('pantry', item);
        toast(`Added ${item.name}`);
        await refresh();
        return true;
      }

      body.append(
        el('div', { class: 'addopts' },
          el('button', {
            class: 'btn-scan',
            onclick: () => { api.close(); openScannerFlow(); },
          }, el('span', { html: BARCODE_ICON }), 'Scan barcode'),
          el('button', {
            class: 'btn-scan',
            onclick: () => { api.close(); openOrderPaste({ onDone: refresh }); },
          }, el('span', { html: CLIPBOARD_ICON }), 'Paste order')
        ),
        form.root,
        el('div', { class: 'sheet-actions' },
          el('button', {
            class: 'btn btn-secondary',
            onclick: async () => { if (await commit()) { form.reset(); form.focusName(); } },
          }, 'Add & another'),
          el('button', {
            class: 'btn btn-primary',
            onclick: async () => { if (await commit()) api.close(); },
          }, 'Add')
        )
      );
      setTimeout(() => form.focusName(), 120);
    },
  });
}

/* ── Edit ── */

function openEditSheet(item) {
  openSheet({
    title: 'Edit item',
    build(body, api) {
      const form = buildItemForm(item, { showNutrition: true });

      const metaBits = [`Added ${fmtDateShort(new Date(item.addedAt).toISOString().slice(0, 10))}`];
      metaBits.push(item.source === 'barcode' ? 'scanned' : item.source || 'manual');
      if (item.barcode) metaBits.push(item.barcode);

      const BIN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13.5h9l1-13.5M10 11v6M14 11v6"/></svg>';
      body.append(
        form.root,
        item.quantity.amount > 0
          ? el('button', {
              class: 'btn-scan', style: 'margin-top:18px',
              onclick: () => { api.close(); openWasteSheet({ item, onDone: refresh }); },
            }, el('span', { html: BIN_ICON }), 'Threw it out — log as waste')
          : null,
        el('div', { class: 'sheet-actions' },
          el('button', {
            class: 'btn btn-danger',
            onclick: async () => {
              await dbDel('pantry', item.id);
              api.close();
              await refresh();
              toast(`Deleted ${item.name}`, {
                action: 'Undo',
                onAction: async () => { await dbPut('pantry', item); await refresh(); },
              });
            },
          }, 'Delete'),
          el('button', {
            class: 'btn btn-primary',
            onclick: async () => {
              const v = form.read();
              if (!v.name) { form.flagName(); return; }
              const priceChanged = v.price !== (item.price ?? null);
              const updated = {
                ...item,
                name: v.name,
                nameLower: v.name.toLowerCase(),
                quantity: { amount: v.qty, unit: v.unit },
                category: v.category,
                expiryDate: v.expiry,
                notes: v.notes,
                nutrition: v.nutrition,
                price: v.price,
                priceQty: v.price == null ? null
                  : (priceChanged || !item.priceQty ? { amount: v.qty, unit: v.unit } : item.priceQty),
                isStaple: v.isStaple,
                lowAt: v.lowAt,
                updatedAt: Date.now(),
              };
              await dbPut('pantry', updated);
              api.close();
              await refresh();
            },
          }, 'Save')
        ),
        el('div', { class: 'edit-meta' }, metaBits.join(' · '))
      );
    },
  });
}
