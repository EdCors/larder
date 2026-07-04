/* Full-screen camera barcode scanner built on ZXing (vendored, loaded lazily).
   Handles permission/lighting problems with clear retry and a manual fallback. */

import { el } from './ui.js';

const X_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const TORCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4.5 13.5H10L11 22l8.5-11.5H14L13 2z"/></svg>';

let zxingPromise = null;
function loadZXing() {
  if (window.ZXing) return Promise.resolve(window.ZXing);
  if (!zxingPromise) {
    zxingPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'js/vendor/zxing.min.js';
      s.onload = () => resolve(window.ZXing);
      s.onerror = () => { zxingPromise = null; reject(new Error('load failed')); };
      document.head.append(s);
    });
  }
  return zxingPromise;
}

function cameraErrorMessage(err) {
  switch (err && err.name) {
    case 'NotAllowedError':
      return 'Camera access was declined. Allow the camera for this site (tap “aA” in Safari’s address bar → Website Settings), then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No suitable camera was found on this device.';
    case 'NotReadableError':
      return 'The camera appears to be in use by another app. Close it and try again.';
    default:
      return 'The camera could not be started. You can still type the barcode in manually.';
  }
}

export function openScanner({ onCode, onManual }) {
  const video = el('video', { class: 'scan-video', playsinline: true, muted: true, autoplay: true });
  const windowEl = el('div', { class: 'scan-window' });
  const statusEl = el('div', { class: 'scan-status' }, 'Starting camera…');
  const hintEl = el('div', { class: 'scan-hint', hidden: true },
    'Trouble scanning? More light helps — hold steady, 10–15 cm away, barcode filling the frame.');
  const torchBtn = el('button', { class: 'scan-round scan-torch', hidden: true, 'aria-label': 'Toggle torch', html: TORCH_ICON });
  const errorEl = el('div', { class: 'scan-error', hidden: true });

  let reader = null;
  let closed = false;
  let hintTimer = null;

  function cleanup() {
    if (closed) return;
    closed = true;
    clearTimeout(hintTimer);
    try { if (reader) reader.reset(); } catch { /* stream already gone */ }
    overlay.remove();
  }

  const closeBtn = el('button', { class: 'scan-round', 'aria-label': 'Close scanner', html: X_ICON, onclick: cleanup });
  const manualBtn = el('button', { class: 'scan-manual', onclick: () => { cleanup(); onManual(); } }, 'Type barcode manually');

  const overlay = el('div', { class: 'scanner' },
    video,
    windowEl,
    el('div', { class: 'scan-top' }, closeBtn, torchBtn),
    el('div', { class: 'scan-bottom' }, hintEl, statusEl, manualBtn),
    errorEl
  );
  document.body.append(overlay);

  function showError(msg) {
    clearTimeout(hintTimer);
    errorEl.hidden = false;
    errorEl.innerHTML = '';
    errorEl.append(
      el('h3', {}, 'Camera unavailable'),
      el('p', {}, msg),
      el('button', { class: 'btn btn-primary', onclick: () => { cleanup(); openScanner({ onCode, onManual }); } }, 'Try again'),
      el('button', { class: 'btn btn-secondary', onclick: () => { cleanup(); onManual(); } }, 'Type barcode manually'),
      el('button', { class: 'btn btn-ghost', onclick: cleanup }, 'Close')
    );
  }

  (async () => {
    let ZX;
    try {
      ZX = await loadZXing();
    } catch {
      showError('The scanner code could not be loaded. Check your connection once, then try again.');
      return;
    }
    if (closed) return;

    const hints = new Map();
    hints.set(ZX.DecodeHintType.POSSIBLE_FORMATS, [
      ZX.BarcodeFormat.EAN_13, ZX.BarcodeFormat.EAN_8, ZX.BarcodeFormat.UPC_A, ZX.BarcodeFormat.UPC_E,
    ]);
    hints.set(ZX.DecodeHintType.TRY_HARDER, true);
    reader = new ZX.BrowserMultiFormatReader(hints, 150);

    const constraints = {
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    };

    try {
      await reader.decodeFromConstraints(constraints, video, (result) => {
        if (!result || closed) return;
        const code = result.getText();
        windowEl.classList.add('scan-hit');
        statusEl.textContent = `Found ${code}`;
        setTimeout(() => { cleanup(); onCode(code); }, 250);
      });
    } catch (err) {
      if (!closed) showError(cameraErrorMessage(err));
      return;
    }
    if (closed) { try { reader.reset(); } catch { /* noop */ } return; }

    statusEl.textContent = 'Centre the barcode — it scans automatically';
    hintTimer = setTimeout(() => { hintEl.hidden = false; }, 10000);

    // Torch toggle, only where the platform supports it (feature-detected).
    const track = video.srcObject && video.srcObject.getVideoTracks()[0];
    if (track && track.getCapabilities && track.getCapabilities().torch) {
      torchBtn.hidden = false;
      let torchOn = false;
      torchBtn.addEventListener('click', () => {
        torchOn = !torchOn;
        track.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(() => {});
        torchBtn.classList.toggle('on', torchOn);
      });
    }
  })();

  return { close: cleanup };
}
