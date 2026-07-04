/* Recipe import from a URL. The app has no server of its own, so pages are
   fetched through public CORS relays (which do the server-side fetch).
   Extraction preference: schema.org/Recipe JSON-LD → og:description caption
   (social pages often expose it even while blocking scrapers) → page text.
   Failures are surfaced to the caller — never silent. */

import { parseRecipeText, parseIngredientLine, normalizeSteps } from './recipeparse.js';

const RELAYS = [
  { name: 'allorigins', kind: 'html', url: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
  { name: 'corsproxy', kind: 'html', url: (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}` },
  { name: 'jina', kind: 'text', url: (u) => `https://r.jina.ai/${u}` },
];

async function fetchVia(relay, target) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(relay.url(target), { signal: controller.signal });
    if (!res.ok) return null;
    const text = await res.text();
    return text && text.length > 200 ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function stripHtml(html) {
  const div = document.createElement('div');
  div.innerHTML = String(html);
  return div.textContent.replace(/\s+/g, ' ').trim();
}

function findRecipeNodes(obj, out = []) {
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    obj.forEach((o) => findRecipeNodes(o, out));
    return out;
  }
  const types = Array.isArray(obj['@type']) ? obj['@type'] : [obj['@type']];
  if (types.includes('Recipe')) out.push(obj);
  if (obj['@graph']) findRecipeNodes(obj['@graph'], out);
  if (obj.mainEntity) findRecipeNodes(obj.mainEntity, out);
  return out;
}

/* Gate for unstructured extraction: real recipes quantify things. Login
   walls and article pages produce only amount-less fragments, which must
   not pass as recipes. */
function looksLikeRecipe(parsed) {
  if (!parsed || parsed.onlyUrl) return false;
  return parsed.ingredients.filter((i) => i.amount != null).length >= 2;
}

function parseYield(y) {
  if (y == null) return null;
  const first = Array.isArray(y) ? y[0] : y;
  const m = String(first).match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

function stepsFrom(instructions, out = []) {
  if (!instructions) return out;
  if (typeof instructions === 'string') {
    // Whole method as one HTML string: block tags mark step boundaries.
    const lines = instructions
      .replace(/<(br|\/p|\/li|\/div)[^>]*>/gi, '\n')
      .split('\n')
      .map((line) => stripHtml(line))
      .filter(Boolean);
    out.push(...lines);
    return out;
  }
  if (Array.isArray(instructions)) {
    instructions.forEach((i) => stepsFrom(i, out));
    return out;
  }
  if (typeof instructions === 'object') {
    if (instructions.itemListElement) return stepsFrom(instructions.itemListElement, out);
    const t = stripHtml(instructions.text || instructions.name || '');
    if (t) out.push(t);
  }
  return out;
}

/* Food blogs write dual measurements ("175g/6 oz guanciale (Note 1)") —
   drop the alternate unit and note references from parsed names. */
function tidyName(name) {
  return name
    .replace(/^\/\s*[\d./]+\s*(oz|ounces?|lbs?|pounds?|g|kg|ml|l|litres?|cups?|tbsp|tsp)\b\.?\s*/i, '')
    .replace(/\(\s*notes?\s*\d+[^)]*\)/gi, '')
    .replace(/,?\s*notes?\s+\d+\s*/gi, ' ')
    .replace(/\(\s*[,;]\s*/g, '(')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.])/g, '$1')
    .replace(/[,\s]+$/, '')
    .trim();
}

function fromJsonLd(doc, sourceUrl) {
  const nodes = [];
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      findRecipeNodes(JSON.parse(script.textContent), nodes);
    } catch { /* tolerate malformed blocks */ }
  }
  const r = nodes.find((n) => Array.isArray(n.recipeIngredient) && n.recipeIngredient.length);
  if (!r) return null;
  const ingredients = r.recipeIngredient
    .map((line) => parseIngredientLine(stripHtml(line)))
    .filter(Boolean)
    .map((ing) => ({ ...ing, name: tidyName(ing.name) || ing.name }));
  if (!ingredients.length) return null;
  return {
    title: stripHtml(r.name || ''),
    servings: parseYield(r.recipeYield ?? r.yield) || 2,
    ingredients,
    steps: normalizeSteps(stepsFrom(r.recipeInstructions)),
    sourceUrl,
  };
}

function fromCaption(doc, sourceUrl) {
  const meta = doc.querySelector('meta[property="og:description"], meta[name="description"]');
  const content = meta && meta.getAttribute('content');
  if (!content || content.length < 60) return null;
  const parsed = parseRecipeText(content);
  if (!looksLikeRecipe(parsed)) return null;
  return {
    title: parsed.title || stripHtml(doc.querySelector('meta[property="og:title"]')?.getAttribute('content') || ''),
    servings: parsed.servings || 2,
    ingredients: parsed.ingredients,
    steps: parsed.steps,
    sourceUrl,
  };
}

function fromPageText(textDoc, sourceUrl) {
  for (const node of textDoc.querySelectorAll('script,style,noscript,svg,template')) node.remove();
  const text = (textDoc.body ? textDoc.body.textContent : '').replace(/[ \t]+/g, ' ');
  const parsed = parseRecipeText(text);
  if (!looksLikeRecipe(parsed)) return null;
  return {
    title: parsed.title,
    servings: parsed.servings || 2,
    ingredients: parsed.ingredients,
    steps: parsed.steps,
    sourceUrl,
  };
}

/* Returns { status:'ok', recipe, via } | { status:'badurl' } | { status:'failed' }.
   onStatus(text) receives progress updates for the UI. */
export async function importFromUrl(rawUrl, onStatus = () => {}) {
  let url;
  try {
    url = new URL(String(rawUrl).trim());
    if (!/^https?:$/.test(url.protocol)) throw new Error('scheme');
  } catch {
    return { status: 'badurl' };
  }
  const target = url.href;

  for (const relay of RELAYS) {
    onStatus(relay.kind === 'html' ? 'Fetching the page…' : 'Trying a reader service…');
    const raw = await fetchVia(relay, target);
    if (!raw) continue;
    onStatus('Reading recipe…');
    if (relay.kind === 'html') {
      const doc = new DOMParser().parseFromString(raw, 'text/html');
      // Second parse with block-level line breaks preserved, for text extraction
      const textDoc = new DOMParser().parseFromString(
        raw.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '$&\n'), 'text/html');
      const recipe = fromJsonLd(doc, target) || fromCaption(doc, target) || fromPageText(textDoc, target);
      if (recipe) return { status: 'ok', recipe, via: relay.name };
    } else {
      const parsed = parseRecipeText(raw);
      if (looksLikeRecipe(parsed)) {
        return {
          status: 'ok',
          recipe: { title: parsed.title, servings: parsed.servings || 2, ingredients: parsed.ingredients, steps: parsed.steps, sourceUrl: target },
          via: relay.name,
        };
      }
    }
  }
  return { status: 'failed' };
}
