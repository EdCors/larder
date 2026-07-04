/* Extract a structured recipe from pasted text (web pages, Instagram
   captions, notes). Heuristic by design — the result always opens in the
   editable recipe editor, never saves directly. */

const FRACTIONS = { '½': 0.5, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 0.25, '¾': 0.75, '⅛': 0.125 };

const UNIT_ALIASES = {
  g: 'g', gr: 'g', gram: 'g', grams: 'g',
  kg: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  ml: 'ml', millilitre: 'ml', millilitres: 'ml', milliliter: 'ml', milliliters: 'ml',
  l: 'l', litre: 'l', litres: 'l', liter: 'l', liters: 'l',
  cup: 'cup', cups: 'cup',
  tbsp: 'tbsp', tbsps: 'tbsp', tbs: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  tsp: 'tsp', tsps: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  clove: 'clove', cloves: 'clove',
  can: 'can', cans: 'can', tin: 'can', tins: 'can',
  jar: 'jar', jars: 'jar',
  bottle: 'bottle', bottles: 'bottle',
  slice: 'slice', slices: 'slice',
  pinch: 'pinch', pinches: 'pinch',
  bunch: 'bunch', bunches: 'bunch',
  pack: 'pack', packs: 'pack', packet: 'pack', packets: 'pack',
  sprig: 'sprig', sprigs: 'sprig',
  handful: 'handful', handfuls: 'handful',
  each: 'ea', ea: 'ea',
  box: 'box', boxes: 'box',
};

const INGREDIENTS_HEADER = /^\s*(ingredients?|you.?ll need|what you.?ll? need|shopping list)\b/i;
const METHOD_HEADER = /^\s*(method|instructions?|directions?|steps|preparation|to make|how to)\b/i;

const stripEmoji = (s) => s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, '').trim();

function parseAmount(token) {
  if (!token) return null;
  let t = token.trim().replace(',', '.');
  // "1-2" ranges: take the lower bound
  const range = t.match(/^(\d+(?:\.\d+)?)\s*[-–]\s*\d/);
  if (range) return parseFloat(range[1]);
  let total = 0;
  let found = false;
  // unicode fractions, optionally after a whole number: "1½"
  const uni = t.match(/^(\d+)?\s*([½⅓⅔¼¾⅛])$/);
  if (uni) return (uni[1] ? parseInt(uni[1], 10) : 0) + FRACTIONS[uni[2]];
  // "1 1/2" or "1/2"
  const mixed = t.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) return parseInt(mixed[1], 10) + parseInt(mixed[2], 10) / parseInt(mixed[3], 10);
  const frac = t.match(/^(\d+)\/(\d+)$/);
  if (frac) return parseInt(frac[1], 10) / parseInt(frac[2], 10);
  const plain = t.match(/^(\d+(?:\.\d+)?)$/);
  if (plain) { total = parseFloat(plain[1]); found = true; }
  return found ? total : null;
}

export function parseIngredientLine(raw) {
  let line = stripEmoji(raw).replace(/^[\s•·\-*–—>]+/, '').replace(/\s+/g, ' ').trim();
  if (!line) return null;
  const m = line.match(/^((?:\d+\s+\d+\/\d+)|(?:\d+\/\d+)|(?:\d+(?:[.,]\d+)?(?:\s*[-–]\s*\d+(?:[.,]\d+)?)?)|(?:\d*\s*[½⅓⅔¼¾⅛]))?\s*([a-zA-Z]+)?\.?\s*(.*)$/);
  if (!m) return { name: line, amount: null, unit: null };

  let amount = parseAmount(m[1]);
  let unit = null;
  let name;
  const maybeUnit = (m[2] || '').toLowerCase();
  if (amount != null && UNIT_ALIASES[maybeUnit]) {
    unit = UNIT_ALIASES[maybeUnit];
    name = m[3];
  } else if (amount != null && maybeUnit === 'dozen') {
    amount *= 12;
    unit = 'ea';
    name = m[3];
  } else {
    name = [m[2], m[3]].filter(Boolean).join(' ');
  }
  name = name.replace(/^of\s+/i, '').trim();
  if (!name || name.replace(/[^A-Za-z]/g, '').length < 2) return null;
  return { name: name.charAt(0).toUpperCase() + name.slice(1), amount, unit };
}

const cleanStep = (s) => s.replace(/^step\s*\d+\s*[:.)\-]?\s*/i, '').replace(/^\d+\s*[.)\-]\s*/, '').trim();

export function parseRecipeText(raw) {
  let text = String(raw || '');

  // Capture and remove URLs; a bare link can't be fetched (CORS/Instagram),
  // so it's kept as the source reference only.
  const urlMatch = text.match(/https?:\/\/\S+/);
  const sourceUrl = urlMatch ? urlMatch[0].replace(/[).,]+$/, '') : null;
  text = text.replace(/https?:\/\/\S+/g, ' ');
  if (!text.replace(/\s/g, '')) return { onlyUrl: true, sourceUrl };

  let servings = null;
  const servM = text.match(/(?:serves?|servings?|makes|feeds)\s*:?\s*(\d{1,2})/i);
  if (servM) servings = parseInt(servM[1], 10);

  const lines = text.split(/\r?\n/)
    .map((l) => l.replace(/#\w+/g, '').replace(/\s+/g, ' ').trim())
    .filter((l) => l);

  let title = '';
  const ingredients = [];
  const steps = [];
  let section = null; // null | 'ing' | 'steps'
  const hasIngHeader = lines.some((l) => INGREDIENTS_HEADER.test(l));

  for (const rawLine of lines) {
    const line = rawLine;
    if (INGREDIENTS_HEADER.test(line)) { section = 'ing'; continue; }
    if (METHOD_HEADER.test(line)) { section = 'steps'; continue; }
    if (/^(serves?|servings?|makes|feeds)\s*:?\s*\d/i.test(line)) continue;

    if (!title && !section) {
      const t = stripEmoji(line).replace(/[!.]+$/, '').trim();
      if (t && t.length <= 80) { title = t; continue; }
    }
    // With an explicit Ingredients header, anything before it is preamble.
    if (!section && hasIngHeader) continue;

    if (section === 'ing') {
      const ing = parseIngredientLine(line);
      if (ing) ingredients.push(ing);
      continue;
    }
    if (section === 'steps') {
      const step = cleanStep(stripEmoji(line));
      if (step) steps.push(step);
      continue;
    }

    // No headers found yet: classify by shape. Lines that start with an
    // amount look like ingredients; short fragments too; sentences are steps.
    const ing = parseIngredientLine(line);
    if (ing && ing.amount != null) { ingredients.push(ing); continue; }
    const plain = stripEmoji(line);
    if (plain.length < 40 && !/[.!?]$/.test(plain) && plain.split(' ').length <= 6) {
      const short = parseIngredientLine(plain);
      if (short) { ingredients.push(short); continue; }
    }
    const step = cleanStep(plain);
    if (step) steps.push(step);
  }

  return { onlyUrl: false, title, servings, ingredients, steps, sourceUrl };
}
