/* Small DOM + UI helpers: element builder, bottom sheet, toast, date utils. */

export const $ = (sel, root = document) => root.querySelector(sel);

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'html') node.innerHTML = value; // trusted static markup only (icons)
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

const X_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

/* ── Bottom sheet ── */
let activeSheet = null;

export function openSheet({ title, build, onClose }) {
  if (activeSheet) activeSheet.close(true);

  const root = $('#sheetRoot');
  const backdrop = el('div', { class: 'sheet-backdrop' });
  const body = el('div', { class: 'sheet-body' });
  const sheet = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' });

  let closed = false;
  const api = {
    body,
    sheet,
    close(immediate = false) {
      if (closed) return;
      closed = true;
      activeSheet = null;
      if (immediate) {
        backdrop.remove();
        sheet.remove();
        if (onClose) onClose();
        return;
      }
      backdrop.classList.remove('open');
      sheet.classList.remove('open');
      setTimeout(() => {
        backdrop.remove();
        sheet.remove();
        if (onClose) onClose();
      }, 340);
    },
  };

  sheet.append(
    el('div', { class: 'sheet-head' },
      el('div', { class: 'sheet-grabber' }),
      el('div', { class: 'sheet-titlerow' },
        el('h2', { class: 'sheet-title' }, title || ''),
        el('button', { class: 'sheet-close', 'aria-label': 'Close', html: X_ICON, onclick: () => api.close() })
      )
    ),
    body
  );

  backdrop.addEventListener('click', () => api.close());
  root.append(backdrop, sheet);
  build(body, api);
  requestAnimationFrame(() => {
    backdrop.classList.add('open');
    sheet.classList.add('open');
  });
  activeSheet = api;
  return api;
}

/* Confirmation gate for destructive actions. */
export function confirmSheet({ title, message, confirmLabel, danger = true, onConfirm }) {
  openSheet({
    title,
    build(body, api) {
      body.append(
        el('p', { class: 'confirm-msg' }, message),
        el('div', { class: 'sheet-actions' },
          el('button', { class: 'btn btn-secondary', onclick: () => api.close() }, 'Cancel'),
          el('button', {
            class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
            onclick: () => { api.close(); onConfirm(); },
          }, confirmLabel)
        )
      );
    },
  });
}

/* ── Toast ── */
let toastTimer = null;

export function toast(message, { action, onAction, duration = 4000 } = {}) {
  const root = $('#toastRoot');
  root.innerHTML = '';
  const node = el('div', { class: 'toast' },
    el('span', { class: 'toast-msg' }, message),
    action
      ? el('button', {
          class: 'toast-action',
          onclick: () => {
            clearTimeout(toastTimer);
            node.remove();
            if (onAction) onAction();
          },
        }, action)
      : null
  );
  root.append(node);
  requestAnimationFrame(() => node.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.classList.remove('show');
    setTimeout(() => node.remove(), 260);
  }, duration);
}

/* ── Dates ── */
export function todayISO(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function daysUntil(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(y, m - 1, d);
  return Math.round((target - today) / 86400000);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtDateShort(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const suffix = y !== new Date().getFullYear() ? ` ${y}` : '';
  return `${d} ${MONTHS[m - 1]}${suffix}`;
}

/* Expiry badge: { label, cls } — cls is '', 'warn' or 'bad'. */
export function expiryInfo(iso) {
  const d = daysUntil(iso);
  if (d < 0) return { label: `Expired ${-d}d`, cls: 'bad' };
  if (d === 0) return { label: 'Today', cls: 'bad' };
  if (d === 1) return { label: '1 day', cls: 'warn' };
  if (d <= 3) return { label: `${d} days`, cls: 'warn' };
  if (d <= 14) return { label: `${d} days`, cls: '' };
  return { label: fmtDateShort(iso), cls: '' };
}
