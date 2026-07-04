/* Shopping list: the reviewed output of the weekly plan (only what's
   missing), staples running low, and manual additions. */

import { dbAll, dbPut, dbDel, uuid } from '../db.js';
import { el, toast } from '../ui.js';
import { formatQty, unitById, parseQuick } from '../units.js';
import { fmtMoney } from '../cost.js';

const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

/* ── Review before anything lands on the list ── */

export function openShoppingReview(proposals, { onDone }) {
  const rows = [];
  const listWrap = el('div', { class: 'o-list' });
  const commitBtn = el('button', { class: 'btn btn-primary' });

  const overlay = el('div', { class: 'page' },
    el('div', { class: 'o-head' },
      el('button', { class: 'o-cancel', onclick: close }, 'Cancel'),
      el('div', { class: 'o-title' }, el('h2', {}, 'Review shopping list'))
    ),
    listWrap,
    el('div', { class: 'o-foot' }, commitBtn)
  );

  function close() {
    overlay.classList.remove('open');
    setTimeout(() => overlay.remove(), 360);
  }

  function updateCommit() {
    const n = rows.filter((r) => r.check.checked).length;
    commitBtn.textContent = n ? `Add ${n} item${n === 1 ? '' : 's'} to shopping list` : 'Nothing selected';
    commitBtn.disabled = !n;
  }

  function section(title, items) {
    if (!items.length) return;
    listWrap.append(el('div', { class: 'form-label' }, title));
    const card = el('div', { class: 'card' });
    for (const p of items) {
      const check = el('input', { type: 'checkbox', checked: p.include });
      check.addEventListener('change', updateCommit);
      const input = el('input', {
        class: 'qty-input d-amt', type: 'text', inputmode: 'decimal',
        value: p.amount != null ? String(p.amount) : '', placeholder: 'any',
      });
      input.addEventListener('input', () => { check.checked = true; updateCommit(); });
      rows.push({ p, check, input });
      const meta = [p.reason];
      if (p.estCost != null) meta.push(`est ${fmtMoney(p.estCost)}`);
      if (p.already) meta.push('already on your list');
      card.append(
        el('label', { class: 'd-row' },
          check,
          el('div', { class: 'd-main' },
            el('div', { class: 'd-name' }, p.name),
            el('div', { class: 'd-meta' }, meta.filter(Boolean).join(' · '))
          ),
          el('div', { class: 'd-input' }, input, el('span', { class: 'd-unit' }, unitById(p.unit)?.label || p.unit || ''))
        )
      );
    }
    listWrap.append(card);
  }

  section('Missing for the week', proposals.filter((p) => p.source === 'plan'));
  section('Staples running low', proposals.filter((p) => p.source === 'staple'));
  if (!proposals.length) {
    listWrap.append(el('div', { class: 'empty' },
      el('h3', {}, 'Nothing missing'),
      el('p', {}, 'Your pantry covers everything in this week’s plan, and no staples are running low.')));
  }

  commitBtn.addEventListener('click', async () => {
    let added = 0;
    for (const { p, check, input } of rows) {
      if (!check.checked) continue;
      const amt = parseFloat(String(input.value).replace(',', '.'));
      await dbPut('shopping', {
        id: uuid(),
        name: p.name,
        nameLower: p.name.toLowerCase(),
        quantity: Number.isFinite(amt) && amt > 0 ? { amount: Math.round(amt * 100) / 100, unit: p.unit } : null,
        estCost: p.estCost ?? null,
        source: p.source,
        reason: p.reason || '',
        status: 'open',
        addedAt: Date.now(),
        updatedAt: Date.now(),
      });
      added++;
    }
    toast(`Added ${added} item${added === 1 ? '' : 's'} to shopping list`);
    close();
    onDone();
  });

  updateCommit();
  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
}

/* ── The list itself (rendered inside the Plan tab) ── */

export async function renderShopping(container, { onChanged, setSubtitle }) {
  const items = await dbAll('shopping');
  const open = items.filter((i) => i.status === 'open').sort((a, b) => a.nameLower.localeCompare(b.nameLower));
  const done = items.filter((i) => i.status === 'done').sort((a, b) => b.updatedAt - a.updatedAt);

  const estSum = open.reduce((s, i) => s + (i.estCost || 0), 0);
  setSubtitle(open.length
    ? `${open.length} to buy${estSum ? ` · est ${fmtMoney(estSum)}` : ''}`
    : (done.length ? 'all ticked off' : ''));

  const wrap = el('div', {});

  const buildRow = (item) => {
    const meta = [];
    if (item.quantity) meta.push(formatQty(item.quantity.amount, item.quantity.unit));
    if (item.estCost != null) meta.push(`est ${fmtMoney(item.estCost)}`);
    if (item.source === 'staple') meta.push('staple');
    if (item.source === 'plan' && item.reason) meta.push(item.reason);
    return el('div', { class: `o-row shop-row${item.status === 'done' ? ' shop-done' : ''}` },
      el('button', {
        class: `o-check${item.status === 'done' ? ' on' : ''}`, html: CHECK,
        'aria-label': item.status === 'done' ? 'Mark as to buy' : 'Mark as bought',
        onclick: async () => {
          item.status = item.status === 'done' ? 'open' : 'done';
          item.updatedAt = Date.now();
          await dbPut('shopping', item);
          onChanged();
        },
      }),
      el('div', { class: 'o-main' },
        el('div', { class: 'o-name' }, item.name),
        meta.length ? el('div', { class: 'o-meta' }, meta.join(' · ')) : null
      ),
      el('button', {
        class: 'ing-del', 'aria-label': 'Remove',
        html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
        onclick: async () => {
          await dbDel('shopping', item.id);
          onChanged();
          toast(`Removed ${item.name}`, { action: 'Undo', onAction: async () => { await dbPut('shopping', item); onChanged(); } });
        },
      })
    );
  };

  // Manual quick add (understands "bread 2" / "milk 2L" shorthand)
  const addInput = el('input', { class: 'field-input', type: 'text', placeholder: 'Add item — e.g. Dish soap', autocomplete: 'off' });
  const addRow = el('div', { class: 'shop-add' },
    addInput,
    el('button', {
      class: 'btn btn-primary shop-add-btn',
      onclick: async () => {
        const parsed = parseQuick(addInput.value);
        if (!parsed.name) return;
        const name = parsed.name.charAt(0).toUpperCase() + parsed.name.slice(1);
        await dbPut('shopping', {
          id: uuid(), name, nameLower: name.toLowerCase(),
          quantity: parsed.qty != null ? { amount: parsed.qty, unit: parsed.unit || 'ea' } : null,
          estCost: null, source: 'manual', reason: '', status: 'open',
          addedAt: Date.now(), updatedAt: Date.now(),
        });
        addInput.value = '';
        onChanged();
      },
    }, 'Add')
  );
  wrap.append(addRow);

  if (!open.length && !done.length) {
    wrap.append(el('div', { class: 'empty' },
      el('h3', {}, 'Shopping list is empty'),
      el('p', {}, 'Build one from your weekly plan, or add items above.')));
  }

  if (open.length) {
    const card = el('div', { class: 'card', style: 'margin-top:12px' });
    open.forEach((i) => card.append(buildRow(i)));
    wrap.append(card);
  }

  if (done.length) {
    wrap.append(el('div', { class: 'shop-done-head' },
      el('span', { class: 'form-label', style: 'margin:0' }, `Done (${done.length})`),
      el('button', {
        class: 'disclosure', style: 'margin:0',
        onclick: async () => { for (const d of done) await dbDel('shopping', d.id); onChanged(); },
      }, 'Clear done')
    ));
    const card = el('div', { class: 'card' });
    done.forEach((i) => card.append(buildRow(i)));
    wrap.append(card);
  }

  container.append(wrap);
}
