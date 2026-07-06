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
const METHOD_HEADER = /^\s*(?:cooking\s+|the\s+)?(method|instructions?|directions?|steps|preparation|to make|how to)\b/i;
const TIPS_HEADER = /^\s*(storage|reheating|notes?|tips?|nutrition(al)?|macros|serving suggestion)/i;

/* Section headers are short labels, not sentences. */
const isHeader = (line, re) => re.test(line) && line.split(/\s+/).length <= 5 && !/[.!?]$/.test(line.trim());

/* A line that is ONLY an amount ("600 g", "2.5 tsp", "10") — some formats
   put the ingredient name on the following line. */
const UNIT_WORD = /^(g|gr|grams?|kg|kilos?|ml|l|litres?|liters?|cups?|tbsp|tbs|tablespoons?|tsp|teaspoons?|cloves?|cans?|tins?|jars?|bottles?|slices?|pinch(es)?|bunch(es)?|packs?|packets?|sprigs?|handfuls?|each|ea|box(es)?|dozen)$/i;
function amountOnly(line) {
  const m = line.trim().match(/^((?:\d+\s+\d\/\d)|(?:\d+\/\d)|(?:\d+(?:[.,]\d+)?)|(?:\d*\s*[½⅓⅔¼¾⅛]))\s*([a-zA-Z]+)?\.?$/);
  if (!m) return null;
  if (m[2] && !UNIT_WORD.test(m[2])) return null;
  return `${m[1]}${m[2] ? ` ${m[2]}` : ''}`.trim();
}

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

/* Steps sometimes arrive glued together ("1. Boil 2. Fry" in one line, or a
   whole method as a single paragraph). Cook mode wants one action per step,
   so split at inline numbering and, for long paragraphs, at sentence
   boundaries in readable chunks. */
function splitInlineNumbers(text) {
  const markers = [...text.matchAll(/(?:^|\s)\d{1,2}[.)]\s+/g)];
  if (markers.length < 2) return null; // needs "1. … 2. …" to be numbering
  const parts = text.split(/(?:^|\s)\d{1,2}[.)]\s+/)
    .map((p) => p.trim())
    .filter((p) => p.replace(/[^A-Za-z]/g, '').length >= 3);
  return parts.length >= 2 ? parts : null;
}

export function normalizeSteps(steps) {
  const out = [];
  for (const raw of steps) {
    const step = String(raw).trim();
    if (!step) continue;
    const inline = splitInlineNumbers(step);
    if (inline) { out.push(...inline); continue; }
    if (step.length > 180) {
      const sentences = step.replace(/([.!?])\s+(?=[A-Z0-9])/g, '$1\n').split('\n');
      if (sentences.length > 1) {
        let buffer = '';
        for (const sentence of sentences) {
          if (buffer && buffer.length + sentence.length + 1 > 140) { out.push(buffer); buffer = sentence; }
          else buffer = buffer ? `${buffer} ${sentence}` : sentence;
        }
        if (buffer) out.push(buffer);
        continue;
      }
    }
    out.push(step);
  }
  return out;
}

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
  let section = null; // null | 'ing' | 'steps' | 'other'
  let lastKind = null; // classification of the previous header-less line
  let pendingAmount = null; // "600 g" on its own line, name expected next
  let firstGroupLabel = ''; // sub-heading like "Garlic Parmesan Chicken"
  const hasIngHeader = lines.some((l) => isHeader(l, INGREDIENTS_HEADER));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isHeader(line, INGREDIENTS_HEADER)) { section = 'ing'; pendingAmount = null; continue; }
    if (isHeader(line, METHOD_HEADER)) { section = 'steps'; pendingAmount = null; continue; }
    if (isHeader(line, TIPS_HEADER)) { section = 'other'; pendingAmount = null; continue; }
    if (section === 'other') continue;
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
      // Amount on its own line — hold it for the ingredient name that follows.
      const amt = amountOnly(line);
      if (amt != null) { pendingAmount = amt; continue; }
      let text = line;
      if (pendingAmount) {
        text = `${pendingAmount} ${line}`;
        pendingAmount = null;
      } else {
        // An unquantified line right before an amount-only line is a group
        // label ("Creamy Sauce"), not an ingredient. Keep the first as a
        // title candidate — it's usually the dish name.
        const next = i + 1 < lines.length ? lines[i + 1] : '';
        if (amountOnly(next) != null) {
          if (!firstGroupLabel) firstGroupLabel = stripEmoji(line);
          continue;
        }
      }
      const ing = parseIngredientLine(text);
      if (ing) ingredients.push(ing);
      continue;
    }
    if (section === 'steps') {
      if (SOCIAL_NOISE.test(line)) continue;
      if (/^\d+\s*[.):]?$/.test(line.trim())) continue; // step number on its own line
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
    // 3) A leading amount is an ingredient. An amount alone on its own line
    //    pairs with the next line — unless that line reads like an
    //    instruction, in which case the number was step numbering.
    const bare = amountOnly(plain);
    if (bare != null && i + 1 < lines.length) {
      const nextLine = stripEmoji(lines[i + 1]);
      if (!COOKING_VERBS.has(firstWord(nextLine)) && nextLine.length < 60) {
        const combined = parseIngredientLine(`${bare} ${nextLine}`);
        if (combined && combined.amount != null) {
          ingredients.push(combined);
          lastKind = 'ing';
          i++;
          continue;
        }
      } else {
        continue; // bare step number — the instruction line classifies itself
      }
    }
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

  if (!title && firstGroupLabel) title = firstGroupLabel;
  return { onlyUrl: false, title, servings, ingredients, steps: normalizeSteps(steps), sourceUrl };
}
