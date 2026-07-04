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

/* Signals for classifying header-less text (Instagram/TikTok captions). */
const COOKING_VERBS = new Set([
  'add', 'mix', 'stir', 'blend', 'cook', 'bake', 'fry', 'heat', 'preheat', 'pour', 'whisk',
  'combine', 'serve', 'top', 'season', 'simmer', 'boil', 'roast', 'grill', 'chop', 'slice',
  'dice', 'melt', 'place', 'drain', 'toss', 'garnish', 'fold', 'beat', 'knead', 'rest',
  'marinate', 'cover', 'remove', 'transfer', 'sprinkle', 'drizzle', 'repeat', 'enjoy', 'let',
  'bring', 'reduce', 'spread', 'layer', 'assemble', 'microwave', 'flip', 'cool', 'chill',
  'freeze', 'squeeze', 'grate', 'crumble', 'rub', 'brush', 'roll', 'cut', 'mash', 'puree',
  'saute', 'sear', 'coat', 'dip', 'shake', 'strain', 'scoop', 'arrange', 'divide', 'warm',
  'pat', 'crack', 'grease', 'blitz', 'whizz', 'tip', 'fill', 'wrap', 'press', 'stack', 'swirl',
]);
const SOCIAL_NOISE = /\b(follow|like and|tag a|tag your|link in bio|save this|comment|subscribe|dm me|recipe (below|in bio)|full recipe|tried this|let me know|watch (the|my)|tutorial|giveaway|credit|via @|shop |use code)\b/i;
const NUMBERED_STEP = /^(?:step\s*\d+\s*[:.)-]?|\d+\s*[.):])\s+/i;

const firstWord = (s) => (s.match(/[a-zA-Z']+/) || [''])[0].toLowerCase();
const containsCookingVerb = (s) => s.toLowerCase().split(/[^a-z']+/).some((w) => COOKING_VERBS.has(w));

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
  let lastKind = null; // classification of the previous header-less line
  const hasIngHeader = lines.some((l) => INGREDIENTS_HEADER.test(l));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (INGREDIENTS_HEADER.test(line)) { section = 'ing'; continue; }
    if (METHOD_HEADER.test(line)) { section = 'steps'; continue; }
    if (/^(serves?|servings?|makes|feeds)\s*:?\s*\d/i.test(line)) continue;

    if (!title && !section) {
      let t = stripEmoji(line).replace(/[!.]+$/, '').trim();
      const letters = t.replace(/[^A-Za-z]/g, '');
      if (letters.length >= 4 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.7) {
        t = t.toLowerCase().replace(/(^|\s)[a-z]/g, (c) => c.toUpperCase());
      }
      if (t && t.length <= 80) { title = t; continue; }
    }
    // With an explicit Ingredients header, anything before it is preamble.
    if (!section && hasIngHeader) continue;

    if (section === 'ing') {
      if (SOCIAL_NOISE.test(line)) continue;
      const ing = parseIngredientLine(line);
      if (ing) ingredients.push(ing);
      continue;
    }
    if (section === 'steps') {
      if (SOCIAL_NOISE.test(line)) continue;
      const step = cleanStep(stripEmoji(line));
      if (step) steps.push(step);
      continue;
    }

    // No headers (typical Instagram/TikTok caption): classify each line.
    const plain = stripEmoji(line);
    // 1) Social chatter and bare @mentions are neither.
    if (SOCIAL_NOISE.test(plain) || /^@[\w.]+$/.test(plain)) continue;
    // 2) Explicit numbering is an instruction, even though it starts with a digit.
    if (NUMBERED_STEP.test(plain)) {
      const step = cleanStep(plain);
      if (step) { steps.push(step); lastKind = 'step'; }
      continue;
    }
    // 3) A leading amount is an ingredient.
    const ing = parseIngredientLine(line);
    if (ing && ing.amount != null) { ingredients.push(ing); lastKind = 'ing'; continue; }
    // 4) Imperative cooking verb up front is an instruction ("Blend until smooth").
    if (COOKING_VERBS.has(firstWord(plain))) {
      const step = cleanStep(plain);
      if (step) { steps.push(step); lastKind = 'step'; }
      continue;
    }
    // 5) Questions are engagement bait, not recipe content.
    if (/\?\s*$/.test(plain)) continue;
    // 6) Sentences that talk about cooking are instructions ("Once boiling, reduce the heat").
    if (containsCookingVerb(plain) && (/[.!]\s*$/.test(plain) || plain.length >= 30)) {
      const step = cleanStep(plain);
      if (step) { steps.push(step); lastKind = 'step'; }
      continue;
    }
    // 7) Short unquantified lines ("Parmesan", "Salt & pepper") count as
    //    ingredients only when they sit inside an ingredient block.
    if (plain.length < 40 && plain.split(/\s+/).length <= 6) {
      const next = i + 1 < lines.length ? parseIngredientLine(lines[i + 1]) : null;
      const nextIsIngredient = next && next.amount != null && !NUMBERED_STEP.test(lines[i + 1]);
      if (lastKind === 'ing' || nextIsIngredient) {
        const short = parseIngredientLine(plain);
        if (short) { ingredients.push(short); lastKind = 'ing'; continue; }
      }
    }
    // 8) Anything else is caption chatter — dropped, not misfiled.
  }

  return { onlyUrl: false, title, servings, ingredients, steps, sourceUrl };
}
