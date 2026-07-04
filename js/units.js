/* Units, categories, quantity formatting and quick-add text parsing.
   Mass and volume units convert within their dimension; count-style units
   (each, pack, can…) are not interchangeable with anything else. */

export const UNITS = [
  { id: 'g',      label: 'g',      dim: 'mass',   factor: 1,    step: 50 },
  { id: 'kg',     label: 'kg',     dim: 'mass',   factor: 1000, step: 0.25 },
  { id: 'ml',     label: 'ml',     dim: 'volume', factor: 1,    step: 50 },
  { id: 'l',      label: 'L',      dim: 'volume', factor: 1000, step: 0.25 },
  { id: 'ea',     label: 'each',   dim: 'count',  factor: 1,    step: 1 },
  { id: 'pack',   label: 'pack',   dim: 'count',  factor: 1,    step: 1 },
  { id: 'bunch',  label: 'bunch',  dim: 'count',  factor: 1,    step: 1 },
  { id: 'can',    label: 'can',    dim: 'count',  factor: 1,    step: 1 },
  { id: 'jar',    label: 'jar',    dim: 'count',  factor: 1,    step: 1 },
  { id: 'bottle', label: 'bottle', dim: 'count',  factor: 1,    step: 1 },
  { id: 'box',    label: 'box',    dim: 'count',  factor: 1,    step: 1 },
];

export const unitById = (id) => UNITS.find((u) => u.id === id);

/* Recipe-only units. Volume equivalents use Australian metric measures
   (cup 250 ml, tablespoon 20 ml). Solids measured in cups need density,
   so those conversions stay manual — the deduction review handles it. */
export const KITCHEN_UNITS = [
  { id: 'cup',     label: 'cup',     ml: 250 },
  { id: 'tbsp',    label: 'tbsp',    ml: 20 },
  { id: 'tsp',     label: 'tsp',     ml: 5 },
  { id: 'clove',   label: 'clove',   ml: null },
  { id: 'slice',   label: 'slice',   ml: null },
  { id: 'pinch',   label: 'pinch',   ml: null },
  { id: 'sprig',   label: 'sprig',   ml: null },
  { id: 'handful', label: 'handful', ml: null },
];

export const INGREDIENT_UNITS = [
  ...UNITS.map((u) => ({ id: u.id, label: u.label })),
  ...KITCHEN_UNITS.map((u) => ({ id: u.id, label: u.label })),
];

export const ingredientUnitLabel = (id) => {
  if (!id) return '';
  return (unitById(id) || KITCHEN_UNITS.find((u) => u.id === id) || { label: id }).label;
};

/* Convert a recipe amount into a pantry item's unit; null when it can't be
   done honestly (e.g. cups of flour → grams needs density). */
export function convertIngredient(amount, fromUnit, toUnit) {
  const direct = convert(amount, fromUnit, toUnit);
  if (direct != null) return direct;
  const kitchen = KITCHEN_UNITS.find((u) => u.id === fromUnit);
  if (kitchen && kitchen.ml) {
    const viaMl = convert(amount * kitchen.ml, 'ml', toUnit);
    if (viaMl != null) return viaMl;
  }
  return null;
}

export function convert(amount, fromId, toId) {
  if (fromId === toId) return amount;
  const from = unitById(fromId);
  const to = unitById(toId);
  if (!from || !to || from.dim !== to.dim) return null;
  if (from.dim === 'count') return null;
  return (amount * from.factor) / to.factor;
}

const trimNum = (n) => String(Math.round(n * 100) / 100);

export function formatQty(amount, unitId) {
  let unit = unitById(unitId) || { label: unitId };
  let value = amount;
  if (unitId === 'g' && amount >= 1000) { value = amount / 1000; unit = unitById('kg'); }
  if (unitId === 'ml' && amount >= 1000) { value = amount / 1000; unit = unitById('l'); }
  return `${trimNum(value)} ${unit.label}`;
}

export const CATEGORIES = [
  { id: 'produce',    label: 'Produce',             color: '#59A96A' },
  { id: 'dairy',      label: 'Dairy & Eggs',        color: '#7BA7D7' },
  { id: 'meat',       label: 'Meat & Seafood',      color: '#C97A6B' },
  { id: 'bakery',     label: 'Bakery',              color: '#C7A15A' },
  { id: 'dry',        label: 'Dry goods',           color: '#A98F6B' },
  { id: 'frozen',     label: 'Frozen',              color: '#6BAFC9' },
  { id: 'drinks',     label: 'Drinks',              color: '#8A7BC9' },
  { id: 'snacks',     label: 'Snacks',              color: '#D0925F' },
  { id: 'condiments', label: 'Condiments & Sauces', color: '#B0788F' },
  { id: 'household',  label: 'Household',           color: '#8B9199' },
  { id: 'other',      label: 'Other',               color: '#9AA294' },
];

export const catById = (id) => CATEGORIES.find((c) => c.id === id);

const UNIT_ALIASES = {
  g: 'g', gram: 'g', grams: 'g',
  kg: 'kg', kilo: 'kg', kilos: 'kg',
  ml: 'ml',
  l: 'l', litre: 'l', litres: 'l', liter: 'l', liters: 'l',
  pack: 'pack', packs: 'pack', pk: 'pack',
  bunch: 'bunch', bunches: 'bunch',
  can: 'can', cans: 'can',
  jar: 'jar', jars: 'jar',
  bottle: 'bottle', bottles: 'bottle',
  box: 'box', boxes: 'box',
  ea: 'ea', each: 'ea',
};

/* Parse quick-add text like "Grapes 500g", "2 packs pasta", "Milk x2".
   Returns { name, qty, unit } — qty/unit are null when nothing was detected.
   The result is always shown to the user in editable fields before saving. */
export function parseQuick(raw) {
  const text = raw.trim();
  if (!text) return { name: '', qty: null, unit: null };

  let qty = null;
  let unit = null;
  let match = null;

  const metric = text.match(/(\d+(?:[.,]\d+)?)\s*(kg|kilos?|g|grams?|ml|l|litres?|liters?)\b\.?/i);
  const countWord = text.match(/\b(\d+(?:[.,]\d+)?)\s*(packs?|pk|bunch(?:es)?|cans?|jars?|bottles?|box(?:es)?|each|ea)\b/i);
  const timesAfter = text.match(/(?:^|\s)x\s*(\d+)\b/i);
  const timesBefore = text.match(/\b(\d+)\s*x(?=\s|$)/i);
  const trailingNum = text.match(/\s(\d+)$/);

  if (metric) {
    qty = parseFloat(metric[1].replace(',', '.'));
    unit = UNIT_ALIASES[metric[2].toLowerCase()];
    match = metric;
  } else if (countWord) {
    qty = parseFloat(countWord[1].replace(',', '.'));
    unit = UNIT_ALIASES[countWord[2].toLowerCase()];
    match = countWord;
  } else if (timesAfter) {
    qty = parseInt(timesAfter[1], 10);
    unit = 'ea';
    match = timesAfter;
  } else if (timesBefore) {
    qty = parseInt(timesBefore[1], 10);
    unit = 'ea';
    match = timesBefore;
  } else if (trailingNum) {
    qty = parseInt(trailingNum[1], 10);
    unit = 'ea';
    match = trailingNum;
  }

  let name = text;
  if (match) {
    name = (text.slice(0, match.index) + ' ' + text.slice(match.index + match[0].length))
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
  name = name.replace(/^of\s+/i, '').replace(/\s+of$/i, '');

  return { name, qty, unit };
}
