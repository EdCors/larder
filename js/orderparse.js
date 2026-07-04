/* Heuristic parser for pasted supermarket orders (Woolworths, Coles, email
   confirmations…). Output always goes through the review screen — the parser
   aims for a good first guess, never a silent commit. */

const NOISE_RE = /^(your order|order (no|number|summary|details|total)|subtotal|total|delivery|shipping|pickup|packing|savings|discount|invoice|tax invoice|gst|payment|thank|receipt|balance|rewards|everyday rewards|flybuys|points|special price|promotion|checkout|abn|customer|contact|phone|email)/i;
const SKIP_CONTAINS = /(out of stock|unavailable|substitut|refunded?)/i;

function isMostlyUpper(s) {
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (letters.length < 4) return false;
  return letters.replace(/[^A-Z]/g, '').length / letters.length > 0.7;
}

const titleCase = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

function parseItemLine(line) {
  let work = ' ' + line + ' ';
  const it = { name: '', price: null, _mult: 1, _kind: 'none', _sizeAmount: null, _sizeUnit: null, _packN: null };

  // Price: take the last $ amount on the line as the line total.
  const prices = [...work.matchAll(/\$\s*(\d+(?:\.\d{1,2})?)/g)];
  if (prices.length) it.price = parseFloat(prices[prices.length - 1][1]);
  work = work.replace(/\$\s*\d+(?:\.\d{1,2})?/g, ' ');

  // Multipliers: "5 @ …", "2 x Name", "Qty: 2", "Name x2".
  let m;
  if ((m = work.match(/(\d{1,3})\s*@/))) { it._mult = parseInt(m[1], 10); work = work.replace(m[0], ' '); }
  if ((m = work.match(/^\s*(\d{1,3})\s*[x×]\s+/i))) { it._mult = parseInt(m[1], 10); work = work.replace(m[0], ' '); }
  else if ((m = work.match(/\bqty:?\s*(\d{1,3})\b/i))) { it._mult = parseInt(m[1], 10); work = work.replace(m[0], ' '); }
  else if ((m = work.match(/\s[x×]\s*(\d{1,3})\s*$/i))) { it._mult = parseInt(m[1], 10); work = work.replace(m[0], ' '); }

  // Sizes: explicit "each" beats "N pack" beats mass/volume.
  const sizeM = work.match(/(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l|litres?|liters?)\b/i);
  const packM = work.match(/(\d{1,3})\s*(?:pk|pack)\b/i);
  const eachM = work.match(/\b(each|ea)\b/i);
  const dozenM = work.match(/\bdozen\b/i);
  if (eachM) it._kind = 'each';
  else if (packM) { it._kind = 'pack'; it._packN = parseInt(packM[1], 10); }
  else if (dozenM) { it._kind = 'pack'; it._packN = 12; }
  else if (sizeM) {
    it._kind = 'size';
    it._sizeAmount = parseFloat(sizeM[1].replace(',', '.'));
    const u = sizeM[2].toLowerCase();
    it._sizeUnit = u.startsWith('lit') ? 'l' : u;
  }
  for (const mm of [eachM, packM, dozenM, sizeM]) if (mm) work = work.replace(mm[0], ' ');
  work = work.replace(/\bapprox(imately)?\.?\b/gi, ' ');

  let name = work.replace(/\s{2,}/g, ' ').trim()
    .replace(/^[-•*,.;:]+/, '').replace(/[-,.;:|]+$/, '').trim();
  if (name.replace(/[^A-Za-z]/g, '').length < 2) return null;
  if (isMostlyUpper(name)) name = titleCase(name);
  it.name = name.charAt(0).toUpperCase() + name.slice(1);
  return it;
}

function finalizeItem(it) {
  let amount;
  let unit;
  if (it._kind === 'each') { amount = it._mult; unit = 'ea'; }
  else if (it._kind === 'pack') { amount = it._mult * (it._packN || 1); unit = 'ea'; }
  else if (it._kind === 'size') { amount = Math.round(it._mult * it._sizeAmount * 100) / 100; unit = it._sizeUnit; }
  else { amount = it._mult; unit = 'ea'; }
  it.quantity = { amount, unit };
  it.include = true;
  it.expiry = null;
  it.category = null;
  it.notes = '';
  it.nutrition = null;
  it.barcode = null;
  it.brand = null;
  it.imageUrl = null;
  it.mergeTarget = null;
  it.mergeOn = false;
  it.matchedFrom = null;
  delete it._mult; delete it._kind; delete it._sizeAmount; delete it._sizeUnit; delete it._packN;
}

export function parseOrder(text) {
  const lines = String(text || '').split(/\r?\n/);
  const items = [];
  let skipped = 0;
  const last = () => items[items.length - 1] || null;

  for (const raw of lines) {
    const line = raw.replace(/[|\t]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!line) continue;

    // Continuation lines ("Qty: 2", "$4.50", "5 @ $0.62") modify the item above.
    let m;
    if ((m = line.match(/^qty:?\s*(\d{1,3})$/i)) && last()) { last()._mult = parseInt(m[1], 10); continue; }
    if ((m = line.match(/^(\d{1,3})\s*@\s*\$?\d+(?:\.\d{1,2})?$/)) && last()) { last()._mult = parseInt(m[1], 10); continue; }
    if ((m = line.match(/^\$\s*(\d+(?:\.\d{1,2})?)$/)) && last()) {
      if (last().price == null) last().price = parseFloat(m[1]);
      continue;
    }

    if (SKIP_CONTAINS.test(line) || NOISE_RE.test(line)) { skipped++; continue; }
    if (line.replace(/[^A-Za-z]/g, '').length < 3) { skipped++; continue; }

    const item = parseItemLine(line);
    if (item) items.push(item);
    else skipped++;
  }

  for (const it of items) finalizeItem(it);
  return { items, skipped };
}
