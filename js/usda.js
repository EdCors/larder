/* USDA FoodData Central search — the source for generic/whole foods that
   Open Food Facts (packaged goods) covers poorly. Uses the shared DEMO_KEY
   unless the user saves their own free key in settings. */

import { getSetting } from './db.js';

const NUTRIENT_MAP = {
  208: 'kcal',     // Energy (kcal)
  203: 'protein',
  205: 'carbs',
  269: 'sugars',
  204: 'fat',
  606: 'satfat',
  291: 'fiber',
  307: 'sodium',   // mg
};

const titleCase = (s) => s.toLowerCase().replace(/(^|[\s,(])[a-z]/g, (c) => c.toUpperCase());

export async function searchUsda(query) {
  const key = (await getSetting('usdaKey')) || 'DEMO_KEY';
  const url = 'https://api.nal.usda.gov/fdc/v1/foods/search'
    + `?api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(query)}`
    + '&pageSize=8&dataType=Foundation,SR%20Legacy';
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.status === 429) return { status: 'ratelimited' };
    if (!res.ok) return { status: 'error' };
    const data = await res.json();
    const foods = (data.foods || [])
      .map((f) => {
        const n = { per: 100, basis: 'g' };
        let any = false;
        for (const fn of f.foodNutrients || []) {
          const id = NUTRIENT_MAP[Number(fn.nutrientNumber)];
          if (id && fn.value != null && n[id] == null) {
            n[id] = Math.round(fn.value * 10) / 10;
            any = true;
          }
        }
        if (n.kcal != null) n.kcal = Math.round(n.kcal);
        return { name: titleCase(String(f.description || '')), nutrition: any ? n : null };
      })
      .filter((f) => f.name && f.nutrition);
    return { status: 'ok', foods };
  } catch {
    return { status: 'error' };
  }
}
