/* Open Food Facts client with an IndexedDB barcode cache.
   Nutrition numbers come only from OFF or the user — never invented. */

import { dbGet, dbPut } from './db.js';

const API = 'https://world.openfoodfacts.org/api/v2/product/';
const FIELDS = 'code,product_name,product_name_en,brands,quantity,product_quantity,product_quantity_unit,nutriments,image_front_small_url';

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/* GTIN check-digit validation (EAN-8 / UPC-A / EAN-13). */
export function validEan(code) {
  if (!/^(\d{8}|\d{12}|\d{13})$/.test(code)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop();
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

function parseQuantity(p) {
  let amount = num(p.product_quantity);
  const unit = String(p.product_quantity_unit || '').toLowerCase();
  const unitMap = { g: 'g', kg: 'kg', ml: 'ml', l: 'l', cl: 'ml', dl: 'ml' };
  if (amount != null && amount > 0 && unitMap[unit]) {
    if (unit === 'cl') amount *= 10;
    if (unit === 'dl') amount *= 100;
    return { amount, unit: unitMap[unit] };
  }
  const m = String(p.quantity || '').match(/([\d.,]+)\s*(kg|g|ml|cl|l)\b/i);
  if (m) {
    let a = parseFloat(m[1].replace(',', '.'));
    let u = m[2].toLowerCase();
    if (u === 'cl') { a *= 10; u = 'ml'; }
    if (Number.isFinite(a) && a > 0) return { amount: a, unit: u };
  }
  return null;
}

function mapNutriments(n, unitHint) {
  const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
  let kcal = num(n['energy-kcal_100g']);
  if (kcal == null && num(n.energy_100g) != null) kcal = num(n.energy_100g) / 4.184; // kJ → kcal
  const out = {
    per: 100,
    basis: unitHint === 'ml' || unitHint === 'l' ? 'ml' : 'g',
    kcal: kcal != null ? Math.round(kcal) : null,
    protein: r1(num(n.proteins_100g)),
    carbs: r1(num(n.carbohydrates_100g)),
    sugars: r1(num(n.sugars_100g)),
    fat: r1(num(n.fat_100g)),
    satfat: r1(num(n['saturated-fat_100g'])),
    fiber: r1(num(n.fiber_100g)),
    sodium: num(n.sodium_100g) != null ? Math.round(num(n.sodium_100g) * 1000) : null, // g → mg
  };
  const any = ['kcal', 'protein', 'carbs', 'sugars', 'fat', 'satfat', 'fiber', 'sodium'].some((k) => out[k] != null);
  return any ? out : null;
}

function mapProduct(p) {
  const quantity = parseQuantity(p);
  return {
    code: p.code || null,
    name: String(p.product_name_en || p.product_name || '').trim(),
    brand: String(p.brands || '').split(',')[0].trim() || null,
    quantity,
    imageUrl: p.image_front_small_url || null,
    nutrition: mapNutriments(p.nutriments || {}, quantity?.unit),
  };
}

/* Free-text product search, used on demand from the order-review editor.
   Note: OFF rate-limits text search (~10/min), so this is never called in bulk. */
export async function searchProducts(query) {
  const url = 'https://world.openfoodfacts.org/cgi/search.pl'
    + `?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=8&fields=${FIELDS}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return { status: 'error' };
    const data = await res.json();
    const products = (data.products || []).map(mapProduct).filter((p) => p.name);
    return { status: 'ok', products };
  } catch {
    return { status: 'error' };
  }
}

/* Returns { status: 'found'|'notfound'|'error', product?, cached?, cacheSource? } */
export async function lookupBarcode(barcode) {
  const cached = await dbGet('barcodeCache', barcode);
  if (cached) return { status: 'found', product: cached.product, cached: true, cacheSource: cached.source };

  const codes = [barcode];
  if (/^\d{12}$/.test(barcode)) codes.push('0' + barcode); // UPC-A also stored as 13-digit in OFF

  for (const code of codes) {
    let data = null;
    try {
      const res = await fetch(`${API}${encodeURIComponent(code)}.json?fields=${FIELDS}`, {
        headers: { Accept: 'application/json' },
      });
      // OFF answers unknown barcodes with 404 + a JSON body; other failures are real errors.
      if (res.ok || res.status === 404) data = await res.json().catch(() => null);
      else return { status: 'error' };
    } catch {
      return { status: 'error' };
    }
    if (data && data.status === 1 && data.product) {
      const product = mapProduct(data.product);
      await dbPut('barcodeCache', { barcode, product, source: 'off', fetchedAt: Date.now() });
      return { status: 'found', product, cached: false };
    }
  }
  return { status: 'notfound' };
}

/* Save a user-entered product so the next scan of this barcode prefills instantly. */
export function rememberManualProduct(barcode, product) {
  return dbPut('barcodeCache', { barcode, product, source: 'manual', fetchedAt: Date.now() });
}
