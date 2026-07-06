/* Phase 3 — paste a supermarket order, parse it, review every line, commit.
   The review list is the gate: nothing reaches the pantry unchecked. */

import { el, openSheet, toast } from '../ui.js';
import { dbGet, dbPut, uuid } from '../db.js';
import { buildItemForm } from '../itemform.js';
import { parseOrder } from '../orderparse.js';
import { attachHistoryNutrition, findMergeTargets } from '../match.js';
import { searchProducts } from '../off.js';
import { convert, formatQty } from '../units.js';
import { checkStaples } from '../staples.js';

const CHEVRON_R = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.8-3.8"/></svg>';

/* ── Step 1: paste sheet ── */

export function openOrderPaste({ onDone }) {
  openSheet({
    title: 'Import an order',
    build(body, api) {
      const ta = el('textarea', {
        class: 'field-input order-paste', rows: '8',
        placeholder: 'Paste the item lines from your Woolworths / Coles order — from the app, website or confirmation email.',
      });
      const err = el('div', { class: 'form-hint form-warn' });
      body.append(
        el('div', { class: 'form-label' }, 'Order text'),
        ta, err,
        el('div', { class: 'sheet-actions' },
          el('button', {
            class: 'btn btn-primary',
            onclick: async () => {
              const { items } = parseOrder(ta.value);
              if (!items.length) {
                err.textContent = 'No items found in that text. Try pasting just the list of items.';
                return;
              }
              await attachHistoryNutrition(items);
              await findMergeTargets(items);
              api.close();
              openOrderReview(items, { onDone });
            },
          }, 'Parse order')
        )
      );
      setTimeout(() => ta.focus(), 120);
    },
  });
}

/* ── Step 2: review list ── */

export function openOrderReview(items, { onDone }) {
  const listWrap = el('div', { class: 'o-list' });
  const subtitleEl = el('div', { class: 'o-sub' });
  const commitBtn = el('button', { class: 'btn btn-primary' });

  const overlay = el('div', { class: 'order-review' },
    el('div', { class: 'o-head' },
      el('button', { class: 'o-cancel', onclick: close }, 'Cancel'),
      el('div', { class: 'o-title' }, el('h2', {}, 'Review order'), subtitleEl)
    ),
    listWrap,
    el('div', { class: 'o-foot' }, commitBtn)
  );

  function close() {
    overlay.classList.remove('open');
    setTimeout(() => overlay.remove(), 360);
  }

  function included() { return items.filter((i) => i.include); }

  function renderRows() {
    listWrap.innerHTML = '';
    const card = el('div', { class: 'card' });
    items.forEach((item) => card.append(buildRow(item)));
    listWrap.append(card, el('div', { class: 'list-count' }, 'Tap a row to edit it before adding.'));

    const inc = included();
    const priced = inc.filter((i) => i.price != null);
    const sum = priced.reduce((s, i) => s + i.price, 0);
    subtitleEl.textContent = `${inc.length} of ${items.length} items${priced.length ? ` · $${sum.toFixed(2)}` : ''}`;
    commitBtn.textContent = inc.length ? `Add ${inc.length} item${inc.length === 1 ? '' : 's'} to pantry` : 'Nothing selected';
    commitBtn.disabled = !inc.length;
  }

  function buildRow(item) {
    const meta = [formatQty(item.quantity.amount, item.quantity.unit)];
    if (item.price != null) meta.push(`$${item.price.toFixed(2)}`);
    if (item.nutrition) meta.push(item.nutrition.kcal != null ? `${item.nutrition.kcal} kcal/100${item.nutrition.basis}` : 'nutrition ✓');

    const mergeChip = item.mergeTarget
      ? el('button', {
          class: `o-merge${item.mergeOn ? ' on' : ''}`,
          onclick: (e) => { e.stopPropagation(); item.mergeOn = !item.mergeOn; renderRows(); },
        }, item.mergeOn
          ? `Tops up “${item.mergeTarget.name}” (${formatQty(item.mergeTarget.quantity.amount, item.mergeTarget.quantity.unit)})`
          : 'Adds as a new item')
      : null;

    const check = el('button', {
      class: `o-check${item.include ? ' on' : ''}`, html: CHECK,
      'aria-label': item.include ? 'Exclude item' : 'Include item',
      onclick: (e) => { e.stopPropagation(); item.include = !item.include; renderRows(); },
    });

    return el('div', {
      class: `o-row${item.include ? '' : ' off'}`, role: 'button', tabindex: '0',
      onclick: () => openItemEditor(item, renderRows),
    },
      check,
      el('div', { class: 'o-main' },
        el('div', { class: 'o-name' }, item.name),
        el('div', { class: 'o-meta' }, meta.join(' · ')),
        mergeChip
      ),
      el('span', { class: 'o-chev', html: CHEVRON_R })
    );
  }

  commitBtn.addEventListener('click', async () => {
    commitBtn.disabled = true;
    let added = 0;
    let merged = 0;
    for (const it of included()) {
      if (it.mergeOn && it.mergeTarget) {
        const target = await dbGet('pantry', it.mergeTarget.id);
        if (target) {
          const conv = convert(it.quantity.amount, it.quantity.unit, target.quantity.unit);
          if (conv != null) {
            target.quantity.amount = Math.round((target.quantity.amount + conv) * 100) / 100;
            if (!target.nutrition && it.nutrition) target.nutrition = it.nutrition;
            if (it.price != null) { target.price = it.price; target.priceQty = { ...it.quantity }; }
            if (it.expiry) target.expiryDate = it.expiry;
            target.updatedAt = Date.now();
            await dbPut('pantry', target);
            merged++;
            continue;
          }
        }
      }
      await dbPut('pantry', {
        id: uuid(),
        name: it.name,
        nameLower: it.name.toLowerCase(),
        quantity: it.quantity,
        category: it.category,
        expiryDate: it.expiry,
        notes: it.notes,
        barcode: it.barcode,
        brand: it.brand,
        imageUrl: it.imageUrl,
        nutrition: it.nutrition,
        price: it.price,
        priceQty: it.price != null ? { ...it.quantity } : null,
        isStaple: false,
        lowAt: null,
        source: 'order',
        addedAt: Date.now(),
        updatedAt: Date.now(),
      });
      added++;
    }
    toast(`Added ${added} item${added === 1 ? '' : 's'}${merged ? ` · topped up ${merged}` : ''}`);
    close();
    onDone();
    checkStaples({ silent: true }); // restocked staples clear their low flag
  });

  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  renderRows();
}

/* ── Step 3: per-item editor (with on-demand OFF nutrition search) ── */

function openItemEditor(item, onChanged) {
  openSheet({
    title: 'Edit item',
    build(body, api) {
      const form = buildItemForm({
        name: item.name,
        quantity: item.quantity,
        expiryDate: item.expiry,
        category: item.category,
        notes: item.notes,
        nutrition: item.nutrition,
      }, { showNutrition: true });

      body.append(form.root, offSearchBlock(form, item));

      body.append(
        el('div', { class: 'sheet-actions' },
          el('button', {
            class: 'btn btn-danger',
            onclick: () => { item.include = false; api.close(); onChanged(); },
          }, 'Exclude'),
          el('button', {
            class: 'btn btn-primary',
            onclick: () => {
              const v = form.read();
              if (!v.name) { form.flagName(); return; }
              item.name = v.name;
              item.quantity = { amount: v.qty, unit: v.unit };
              item.expiry = v.expiry;
              item.category = v.category;
              item.notes = v.notes;
              item.nutrition = v.nutrition;
              api.close();
              onChanged();
            },
          }, 'Done')
        )
      );
    },
  });
}

function offSearchBlock(form, item) {
  const results = el('div', { class: 'off-results' });
  const btn = el('button', {
    class: 'btn-scan',
    onclick: async () => {
      btn.disabled = true;
      results.innerHTML = '';
      results.append(el('div', { class: 'spinner', style: 'margin:14px auto' }));
      const query = form.read().name || item.name;
      const res = await searchProducts(query);
      results.innerHTML = '';
      btn.disabled = false;
      if (res.status !== 'ok') {
        results.append(el('div', { class: 'form-hint form-warn' }, 'Open Food Facts couldn’t be reached — try again in a moment.'));
        return;
      }
      const withNutrition = res.products.filter((p) => p.nutrition);
      if (!withNutrition.length) {
        results.append(el('div', { class: 'form-hint' }, 'No nutrition data found for that name — you can fill it in manually.'));
        return;
      }
      for (const p of withNutrition.slice(0, 6)) {
        results.append(el('button', {
          class: 'off-result',
          onclick: () => {
            form.setNutrition(p.nutrition);
            if (p.code) item.barcode = p.code;
            if (p.brand) item.brand = p.brand;
            if (p.imageUrl) item.imageUrl = p.imageUrl;
            results.innerHTML = '';
            results.append(el('div', { class: 'form-hint' }, `Matched “${p.name}” — nutrition filled in below.`));
          },
        },
          el('div', { class: 'off-r-name' }, p.name),
          el('div', { class: 'off-r-meta' }, [
            p.brand,
            p.quantity ? formatQty(p.quantity.amount, p.quantity.unit) : null,
            p.nutrition.kcal != null ? `${p.nutrition.kcal} kcal/100${p.nutrition.basis}` : 'nutrition ✓',
          ].filter(Boolean).join(' · '))
        ));
      }
    },
  }, el('span', { html: SEARCH_ICON }), 'Search Open Food Facts');

  return el('div', {}, btn, results);
}
