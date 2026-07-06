/* Review-before-commit screens for captured data (Phase 2: barcode scans).
   Nothing reaches the pantry without passing through an editable form here. */

import { el, openSheet, toast } from '../ui.js';
import { dbAll, dbPut, uuid } from '../db.js';
import { buildItemForm } from '../itemform.js';
import { lookupBarcode, rememberManualProduct, validEan } from '../off.js';
import { convert, formatQty } from '../units.js';
import { checkStaples } from '../staples.js';

/* Look a barcode up and open the review sheet. The sheet morphs from a
   loading state into found / not-found / network-error states. */
export function startBarcodeReview(barcode, { onDone, onScanNext }) {
  let open = true;
  openSheet({
    title: 'Review item',
    onClose: () => { open = false; },
    build(body, api) {
      renderLoading(body, barcode);
      lookupBarcode(barcode).then(async (res) => {
        if (!open) return;
        body.innerHTML = '';
        if (res.status === 'error') renderLookupError(body, api, barcode, { onDone, onScanNext });
        else await renderReview(body, api, barcode, res, { onDone, onScanNext });
      });
    },
  });
}

function renderLoading(body, barcode) {
  body.append(
    el('div', { class: 'review-loading' },
      el('div', { class: 'spinner' }),
      el('p', {}, 'Looking up ', el('span', { class: 'barcode-mono' }, barcode), '…')
    )
  );
}

function renderLookupError(body, api, barcode, callbacks) {
  body.append(
    el('div', { class: 'notfound-note' },
      'Open Food Facts couldn’t be reached — check your connection. You can retry, or enter the details yourself.'),
    el('div', { class: 'sheet-actions' },
      el('button', {
        class: 'btn btn-secondary',
        onclick: async () => {
          body.innerHTML = '';
          renderLoading(body, barcode);
          const res = await lookupBarcode(barcode);
          body.innerHTML = '';
          if (res.status === 'error') renderLookupError(body, api, barcode, callbacks);
          else await renderReview(body, api, barcode, res, callbacks);
        },
      }, 'Retry'),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          body.innerHTML = '';
          await renderReview(body, api, barcode, { status: 'notfound' }, callbacks);
        },
      }, 'Enter manually')
    )
  );
}

function sourceLabel(res) {
  if (res.status === 'notfound') return null;
  if (res.cacheSource === 'manual') return 'Saved from your earlier entry';
  if (res.cached) return 'Open Food Facts · saved offline';
  return 'Open Food Facts';
}

async function renderReview(body, api, barcode, res, { onDone, onScanNext }) {
  const product = res.product || null;
  const found = res.status === 'found';

  // Header: what we captured and where it came from.
  const img = product?.imageUrl
    ? el('img', { class: 'review-img', src: product.imageUrl, alt: '' })
    : el('div', { class: 'review-img' });
  if (img.tagName === 'IMG') img.addEventListener('error', () => img.remove());
  body.append(
    el('div', { class: 'review-header' },
      img,
      el('div', { class: 'review-head-main' },
        el('div', { class: 'review-brand' }, found ? (product.brand || product.name || 'Product') : 'New product'),
        el('div', { class: 'review-source' },
          sourceLabel(res) ? `${sourceLabel(res)} · ` : '',
          el('span', { class: 'barcode-mono' }, barcode))
      )
    )
  );

  if (!found) {
    body.append(el('div', { class: 'notfound-note' },
      'This barcode isn’t in Open Food Facts. Fill in the details once — Muffin remembers them for next time.'));
  }

  const form = buildItemForm({
    name: product?.name || '',
    quantity: product?.quantity || { amount: 1, unit: 'ea' },
    nutrition: product?.nutrition || null,
  }, { showNutrition: true });
  body.append(form.root);

  // Same product already in the pantry? Offer to top it up instead of duplicating.
  const existing = (await dbAll('pantry')).find((i) => i.barcode === barcode);
  let combineBox = null;
  if (existing) {
    combineBox = el('input', { type: 'checkbox', checked: true });
    body.append(
      el('label', { class: 'combine-row' },
        combineBox,
        `Combine with “${existing.name}” — currently ${formatQty(existing.quantity.amount, existing.quantity.unit)}`
      )
    );
  }

  let committing = false;
  async function commit(scanNext) {
    if (committing) return;
    const v = form.read();
    if (!v.name) { form.flagName(); return; }
    committing = true;

    if (!found) {
      await rememberManualProduct(barcode, {
        name: v.name,
        brand: null,
        quantity: { amount: v.qty, unit: v.unit },
        imageUrl: null,
        nutrition: v.nutrition,
      });
    }

    let merged = false;
    if (existing && combineBox && combineBox.checked) {
      const converted = convert(v.qty, v.unit, existing.quantity.unit);
      if (converted != null) {
        existing.quantity.amount = Math.round((existing.quantity.amount + converted) * 100) / 100;
        if (!existing.nutrition && v.nutrition) existing.nutrition = v.nutrition;
        if (v.expiry) existing.expiryDate = v.expiry;
        existing.updatedAt = Date.now();
        await dbPut('pantry', existing);
        toast(`Updated ${existing.name} — now ${formatQty(existing.quantity.amount, existing.quantity.unit)}`);
        merged = true;
      } else {
        toast('Units differ from the existing item — added separately');
      }
    }

    if (!merged) {
      const item = {
        id: uuid(),
        name: v.name,
        nameLower: v.name.toLowerCase(),
        quantity: { amount: v.qty, unit: v.unit },
        category: v.category,
        expiryDate: v.expiry,
        notes: v.notes,
        barcode,
        brand: product?.brand || null,
        imageUrl: product?.imageUrl || null,
        nutrition: v.nutrition,
        price: v.price,
        priceQty: v.price != null ? { amount: v.qty, unit: v.unit } : null,
        isStaple: v.isStaple,
        lowAt: v.lowAt,
        source: 'barcode',
        addedAt: Date.now(),
        updatedAt: Date.now(),
      };
      await dbPut('pantry', item);
      toast(`Added ${item.name}`);
    }

    api.close();
    onDone();
    checkStaples({ silent: true }); // restocking clears staple low-flags
    if (scanNext) onScanNext();
  }

  body.append(
    el('div', { class: 'sheet-actions' },
      el('button', { class: 'btn btn-secondary', onclick: () => commit(true) }, 'Add & scan next'),
      el('button', { class: 'btn btn-primary', onclick: () => commit(false) }, 'Add to pantry')
    )
  );
}

/* Manual barcode entry — fallback for damaged codes or no camera access. */
export function openManualBarcode({ onCode }) {
  openSheet({
    title: 'Enter barcode',
    build(body, api) {
      const input = el('input', {
        class: 'field-input barcode-mono', type: 'text', inputmode: 'numeric',
        autocomplete: 'off', placeholder: 'e.g. 9300601234567',
      });
      const warn = el('div', { class: 'form-hint form-warn' });
      input.addEventListener('input', () => {
        const code = input.value.replace(/\D/g, '');
        if (/^(\d{8}|\d{12}|\d{13})$/.test(code) && !validEan(code)) {
          warn.textContent = 'Check digit doesn’t match — double-check the number.';
        } else {
          warn.textContent = '';
        }
      });
      body.append(
        el('div', { class: 'form-label' }, 'Barcode digits'),
        input, warn,
        el('div', { class: 'sheet-actions' },
          el('button', {
            class: 'btn btn-primary',
            onclick: () => {
              const code = input.value.replace(/\D/g, '');
              if (!/^(\d{8}|\d{12}|\d{13})$/.test(code)) {
                input.classList.add('field-error');
                input.focus();
                setTimeout(() => input.classList.remove('field-error'), 1200);
                return;
              }
              api.close();
              onCode(code);
            },
          }, 'Look up')
        )
      );
      setTimeout(() => input.focus(), 120);
    },
  });
}
