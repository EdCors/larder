/* Insights tab: waste logging and simple, honest insights about what gets
   thrown out and over-bought. Values come from recorded purchase prices —
   unpriced waste is counted but never given an invented dollar figure. */

import { dbAll, dbPut, dbDel, uuid } from '../db.js';
import { el, openSheet, toast, todayISO, fmtDateShort, daysUntil, debounce } from '../ui.js';
import { UNITS, formatQty, unitById } from '../units.js';
import { unitPrice, fmtMoney } from '../cost.js';
import { switchTab } from '../app.js';

const REASONS = ['Expired', 'Went off', 'Cooked too much', 'Didn’t like it', 'Other'];
const BIN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13.5h9l1-13.5M10 11v6M14 11v6"/></svg>';
const X_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

const WINDOWS = [
  { id: '30', label: 'Last 30 days' },
  { id: 'all', label: 'All time' },
];

let windowMode = '30';
let bodyEl = null;
let ctxRef = null;

export const insightsView = {
  async mount(container, ctx) {
    ctxRef = ctx;
    const seg = el('div', { class: 'segmented', role: 'group' });
    for (const w of WINDOWS) {
      seg.append(el('button', {
        'aria-pressed': String(w.id === windowMode),
        onclick: (e) => {
          windowMode = w.id;
          for (const b of seg.children) b.setAttribute('aria-pressed', 'false');
          e.currentTarget.setAttribute('aria-pressed', 'true');
          render();
        },
      }, w.label));
    }
    container.append(el('div', { class: 'toolbar' }, seg));
    bodyEl = el('div', { class: 'list-area' });
    container.append(bodyEl);
    await render();
  },
  onFab() {
    openWastePicker({ onDone: render });
  },
};

async function render() {
  if (!bodyEl) return;
  const [waste, pantry] = await Promise.all([dbAll('wasteLog'), dbAll('pantry')]);
  const cutoff = todayISO(-30);
  const entries = (windowMode === '30' ? waste.filter((w) => w.date >= cutoff) : [...waste])
    .sort((a, b) => b.createdAt - a.createdAt);

  const valued = entries.filter((e) => e.estValue != null);
  const totalValue = valued.reduce((s, e) => s + e.estValue, 0);
  ctxRef.setSubtitle(entries.length
    ? `${entries.length} wasted${valued.length ? ` · est ${fmtMoney(totalValue)}` : ''}`
    : '');

  bodyEl.innerHTML = '';

  // Live nudge: things about to expire (waste that hasn't happened yet)
  const soon = pantry.filter((p) => p.quantity.amount > 0 && p.expiryDate && daysUntil(p.expiryDate) <= 3);
  if (soon.length) {
    bodyEl.append(
      el('div', { class: 'insight-card nudge' },
        el('div', { class: 'insight-title' }, `${soon.length} item${soon.length === 1 ? '' : 's'} expiring within 3 days`),
        el('div', { class: 'insight-sub' }, soon.slice(0, 3).map((p) => p.name).join(', ') + (soon.length > 3 ? '…' : '')),
        el('button', {
          class: 'btn-scan', style: 'margin-top:10px',
          onclick: () => {
            localStorage.setItem('larder.recipes.mode', 'useup');
            switchTab('recipes');
          },
        }, 'Cook them first — Use it up')
      )
    );
  }

  if (!entries.length) {
    bodyEl.append(
      el('div', { class: 'empty' },
        el('div', { class: 'empty-icon', html: BIN_ICON }),
        el('h3', {}, 'Nothing logged yet'),
        el('p', {}, 'When you throw food out, log it here. Over time Larder shows what you consistently over-buy or waste.'),
        el('button', { class: 'btn btn-primary', onclick: () => openWastePicker({ onDone: render }) }, 'Log waste')
      )
    );
    return;
  }

  // Summary
  const reasonCounts = {};
  for (const e of entries) reasonCounts[e.reason] = (reasonCounts[e.reason] || 0) + 1;
  const topReason = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])[0];
  bodyEl.append(
    el('div', { class: 'insight-card' },
      el('div', { class: 'budget-row' },
        el('span', { class: 'kcal-big' }, `${valued.length ? `${fmtMoney(totalValue)}` : `${entries.length} items`}`),
        el('span', { class: 'budget-label' }, valued.length ? `wasted · ${entries.length} item${entries.length === 1 ? '' : 's'}` : 'wasted')
      ),
      el('div', { class: 'insight-sub' },
        [
          valued.length && valued.length < entries.length ? `${entries.length - valued.length} unpriced` : null,
          topReason ? `most common reason: ${topReason[0].toLowerCase()}` : null,
        ].filter(Boolean).join(' · '))
    )
  );

  // Most wasted (grouped)
  const groups = new Map();
  for (const e of entries) {
    const g = groups.get(e.nameLower) || { name: e.name, count: 0, value: 0, hasValue: false, last: e.date };
    g.count++;
    if (e.estValue != null) { g.value += e.estValue; g.hasValue = true; }
    if (e.date > g.last) g.last = e.date;
    groups.set(e.nameLower, g);
  }
  const ranked = [...groups.values()].sort((a, b) => b.count - a.count || b.value - a.value).slice(0, 8);

  bodyEl.append(el('div', { class: 'form-label' }, 'Most wasted'));
  const rankCard = el('div', { class: 'card' });
  for (const g of ranked) {
    const meta = [`${g.count}×`];
    if (g.hasValue) meta.push(`est ${fmtMoney(Math.round(g.value * 100) / 100)}`);
    meta.push(`last ${fmtDateShort(g.last)}`);
    rankCard.append(
      el('div', { class: 'row', style: 'cursor:default' },
        el('div', { class: 'row-main' },
          el('div', { class: 'row-name', style: 'font-size:15.5px' }, g.name),
          el('div', { class: 'row-meta' }, meta.join(' · '))),
        g.count >= 2 ? el('span', { class: 'chip-exp warn' }, 'over-buying?') : null
      )
    );
  }
  bodyEl.append(rankCard);

  // Recent entries
  bodyEl.append(el('div', { class: 'form-label' }, 'Recent'));
  const recentCard = el('div', { class: 'card' });
  for (const e of entries.slice(0, 10)) {
    const meta = [fmtDateShort(e.date), e.reason.toLowerCase()];
    if (e.quantity) meta.unshift(formatQty(e.quantity.amount, e.quantity.unit));
    if (e.estValue != null) meta.push(`est ${fmtMoney(e.estValue)}`);
    recentCard.append(
      el('div', { class: 'o-row', style: 'cursor:default' },
        el('div', { class: 'o-main' },
          el('div', { class: 'o-name', style: 'font-size:15px' }, e.name),
          el('div', { class: 'o-meta' }, meta.join(' · '))),
        el('button', {
          class: 'ing-del', 'aria-label': 'Delete entry', html: X_ICON,
          onclick: async () => {
            await dbDel('wasteLog', e.id);
            render();
            toast('Entry removed', { action: 'Undo', onAction: async () => { await dbPut('wasteLog', e); render(); } });
          },
        })
      )
    );
  }
  bodyEl.append(recentCard);
}

/* ── Logging flow ── */

function openWastePicker({ onDone }) {
  openSheet({
    title: 'Log waste',
    async build(body, api) {
      const pantry = (await dbAll('pantry')).filter((p) => p.quantity.amount > 0)
        .sort((a, b) => a.nameLower.localeCompare(b.nameLower));
      const input = el('input', { class: 'field-input', type: 'search', placeholder: 'Search your pantry', autocomplete: 'off' });
      const results = el('div', { class: 'off-results' });

      function renderResults() {
        results.innerHTML = '';
        const q = input.value.trim().toLowerCase();
        const matches = pantry.filter((p) => !q || p.nameLower.includes(q)).slice(0, 8);
        for (const item of matches) {
          results.append(el('button', {
            class: 'off-result',
            onclick: () => { api.close(); openWasteSheet({ item, onDone }); },
          },
            el('div', { class: 'off-r-name' }, item.name),
            el('div', { class: 'off-r-meta' }, `have ${formatQty(item.quantity.amount, item.quantity.unit)}`)
          ));
        }
        if (!matches.length) results.append(el('div', { class: 'form-hint' }, 'No pantry match — log it by name below.'));
      }
      input.addEventListener('input', debounce(renderResults, 120));
      renderResults();

      body.append(
        input, results,
        el('button', { class: 'disclosure', onclick: () => { api.close(); openWasteSheet({ prefillName: input.value.trim(), onDone }); } },
          'Something not in the pantry')
      );
      setTimeout(() => input.focus(), 120);
    },
  });
}

export function openWasteSheet({ item = null, prefillName = '', onDone }) {
  openSheet({
    title: 'Log waste',
    build(body, api) {
      const nameInput = item ? null : el('input', {
        class: 'field-input', type: 'text', autocapitalize: 'words', autocomplete: 'off',
        placeholder: 'e.g. Coriander', value: prefillName,
      });

      const amtInput = el('input', {
        class: 'qty-input', type: 'text', inputmode: 'decimal',
        value: item ? String(item.quantity.amount) : '',
        placeholder: item ? undefined : 'amount',
      });
      let unit = item ? item.quantity.unit : 'ea';
      const unitEl = item
        ? el('span', { class: 'd-unit' }, unitById(unit)?.label || unit)
        : el('select', { class: 'field-select', style: 'width:90px' },
            ...UNITS.map((u) => el('option', { value: u.id, selected: u.id === 'ea' }, u.label)));
      if (!item) unitEl.addEventListener('change', () => { unit = unitEl.value; });

      let reason = REASONS[0];
      const reasonChips = el('div', { class: 'chip-wrap' });
      for (const r of REASONS) {
        reasonChips.append(el('button', {
          class: `chip${reason === r ? ' active' : ''}`,
          onclick: (e) => {
            reason = r;
            for (const c of reasonChips.children) c.classList.remove('active');
            e.currentTarget.classList.add('active');
          },
        }, r));
      }

      const deductBox = item ? el('input', { type: 'checkbox', checked: true }) : null;
      const valueEl = el('div', { class: 'form-hint' });
      const up = item ? unitPrice(item) : null;
      const updateValue = () => {
        if (!up) { valueEl.textContent = ''; return; }
        const a = parseFloat(String(amtInput.value).replace(',', '.'));
        valueEl.textContent = Number.isFinite(a) && a > 0
          ? `Est. value ${fmtMoney(Math.round(a * up.per * 100) / 100)} (from what you paid)`
          : '';
      };
      amtInput.addEventListener('input', updateValue);

      body.append(
        item
          ? el('div', { class: 'review-header' },
              el('div', { class: 'review-head-main' },
                el('div', { class: 'review-brand' }, item.name),
                el('div', { class: 'review-source' }, `have ${formatQty(item.quantity.amount, item.quantity.unit)}`)))
          : el('div', {}, el('div', { class: 'form-label' }, 'What'), nameInput),
        el('div', { class: 'form-label' }, 'How much'),
        el('div', { class: 'qty-row' }, el('div', { class: 'stepper', style: 'padding-right:10px' }, amtInput, unitEl)),
        valueEl,
        el('div', { class: 'form-label' }, 'Why'),
        reasonChips,
        item ? el('label', { class: 'combine-row' }, deductBox, 'Remove this amount from the pantry') : null,
        el('div', { class: 'sheet-actions' },
          el('button', {
            class: 'btn btn-primary',
            onclick: async () => {
              const name = item ? item.name : (nameInput.value.trim() || '');
              if (!name) {
                nameInput.classList.add('field-error');
                nameInput.focus();
                setTimeout(() => nameInput.classList.remove('field-error'), 1200);
                return;
              }
              const a = parseFloat(String(amtInput.value).replace(',', '.'));
              const amount = Number.isFinite(a) && a > 0 ? Math.round(a * 100) / 100 : null;
              const estValue = up && amount != null ? Math.round(amount * up.per * 100) / 100 : null;

              await dbPut('wasteLog', {
                id: uuid(),
                date: todayISO(),
                name: name.charAt(0).toUpperCase() + name.slice(1),
                nameLower: name.toLowerCase(),
                quantity: amount != null ? { amount, unit } : null,
                reason,
                estValue,
                category: item?.category || null,
                refItemId: item?.id || null,
                source: item ? 'pantry' : 'manual',
                createdAt: Date.now(),
              });

              if (item && deductBox.checked && amount != null) {
                item.quantity.amount = Math.max(0, Math.round((item.quantity.amount - amount) * 100) / 100);
                item.updatedAt = Date.now();
                await dbPut('pantry', item);
              }
              api.close();
              toast(`Logged ${name}`);
              onDone();
            },
          }, 'Log waste')
        )
      );
      updateValue();
    },
  });
}
