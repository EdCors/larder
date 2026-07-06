/* Recipe generation via the Anthropic API, called directly from the browser
   (the app has no server) with the user's own API key, which is stored only
   on this device. Structured outputs guarantee a parseable recipe. */

import { dbAll, getSetting, setSetting } from './db.js';
import { INGREDIENT_UNITS } from './units.js';
import { normalizeSteps } from './recipeparse.js';
import { unitPrice } from './cost.js';
import { daysUntil } from './ui.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-4-8';

export const getApiKey = () => getSetting('anthropicKey');
export const setApiKey = (key) => setSetting('anthropicKey', key ? String(key).trim() : null);

const UNIT_IDS = INGREDIENT_UNITS.map((u) => u.id);

const RECIPE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    servings: { type: 'integer' },
    ingredients: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          amount: { anyOf: [{ type: 'number' }, { type: 'null' }] },
          unit: { anyOf: [{ type: 'string', enum: UNIT_IDS }, { type: 'null' }] },
          from_pantry: { type: 'boolean' },
        },
        required: ['name', 'amount', 'unit', 'from_pantry'],
        additionalProperties: false,
      },
    },
    steps: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'servings', 'ingredients', 'steps'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You create practical dinner recipes for an Australian home cook using the Muffin pantry app.

Rules:
- Strongly prefer ingredients from the provided pantry list; keep the number of ingredients that must be bought to a minimum, and mark each ingredient with from_pantry accordingly.
- Prioritise pantry items that are close to their expiry date.
- Use metric Australian measures (g, kg, ml, L; Australian cup = 250 ml, tbsp = 20 ml, tsp = 5 ml). Choose units only from the allowed list; use null for to-taste items.
- Amounts must be realistic for the serving count, and for pantry items should not exceed the quantity available.
- Steps: one clear action per step, roughly 4-10 steps, no numbering in the text.
- Use only common ingredients available in Australian supermarkets. Never invent products.
- The recipe must be genuinely cookable: sensible technique, order and timing.
- Respect the cook's taste signals (liked and previously cooked recipes) and any craving they describe.`;

function buildUserPrompt({ pantry, likedTitles, cookedTitles, craving, serves, budget }) {
  const lines = [];
  lines.push(`Craving: ${craving ? `"${craving}"` : "cook's choice — pick something appealing for dinner"}`);
  lines.push(`Serves: ${serves}`);
  if (budget != null) {
    lines.push(`Budget: the ingredients NOT already in the pantry must cost under $${budget} AUD in total at a typical Australian supermarket (estimate prices conservatively).`);
  }
  lines.push('', 'PANTRY (quantities are what is available):');
  for (const item of pantry.slice(0, 60)) {
    const bits = [`${item.quantity.amount} ${item.quantity.unit}`];
    if (item.expiryDate) {
      const days = daysUntil(item.expiryDate);
      if (days <= 7) bits.push(days <= 0 ? 'expiring today' : `expires in ${days} day${days === 1 ? '' : 's'}`);
    }
    const up = unitPrice(item);
    if (up) bits.push(`$${up.per.toFixed(2)}/${up.unit} paid`);
    lines.push(`- ${item.name} — ${bits.join(', ')}`);
  }
  lines.push('', 'TASTE SIGNALS:');
  lines.push(`Liked recipes: ${likedTitles.length ? likedTitles.join('; ') : 'none yet'}`);
  lines.push(`Previously cooked: ${cookedTitles.length ? cookedTitles.join('; ') : 'none yet'}`);
  return lines.join('\n');
}

function mapGenerated(raw) {
  const unitSet = new Set(UNIT_IDS);
  const servings = Math.min(12, Math.max(1, Math.round(Number(raw.servings)) || 2));
  const ingredients = (Array.isArray(raw.ingredients) ? raw.ingredients : [])
    .slice(0, 30)
    .map((i) => ({
      name: String(i.name || '').trim(),
      amount: typeof i.amount === 'number' && i.amount > 0 ? Math.round(i.amount * 100) / 100 : null,
      unit: unitSet.has(i.unit) ? i.unit : null,
    }))
    .filter((i) => i.name);
  const steps = normalizeSteps((Array.isArray(raw.steps) ? raw.steps : []).map((s) => String(s).trim()).filter(Boolean));
  if (!raw.title || !ingredients.length || !steps.length) return null;
  return {
    title: String(raw.title).slice(0, 120),
    servings,
    ingredients,
    steps,
    sourceUrl: null,
    source: 'ai',
  };
}

/* Returns { status:'ok', recipe } or { status:'nokey'|'auth'|'ratelimit'|'overloaded'|'refusal'|'error', message } */
export async function generateRecipe({ craving = '', serves = 2, budget = null } = {}) {
  const key = await getApiKey();
  if (!key) return { status: 'nokey' };

  const [pantryAll, recipes] = await Promise.all([dbAll('pantry'), dbAll('recipes')]);
  const pantry = pantryAll.filter((p) => p.quantity.amount > 0);
  const likedTitles = recipes.filter((r) => r.liked).map((r) => r.title).slice(0, 10);
  const cookedTitles = recipes.filter((r) => r.timesCooked > 0)
    .sort((a, b) => (b.lastCookedAt || 0) - (a.lastCookedAt || 0))
    .map((r) => `${r.title}${r.timesCooked > 1 ? ` ×${r.timesCooked}` : ''}`)
    .slice(0, 10);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        thinking: { type: 'adaptive' },
        output_config: { format: { type: 'json_schema', schema: RECIPE_SCHEMA } },
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: buildUserPrompt({ pantry, likedTitles, cookedTitles, craving, serves, budget }),
        }],
      }),
    });
  } catch (err) {
    return {
      status: 'error',
      message: err && err.name === 'AbortError'
        ? 'The request timed out — try again.'
        : 'Couldn’t reach the Anthropic API — check your connection.',
    };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let apiMessage = '';
    try { apiMessage = (await res.json())?.error?.message || ''; } catch { /* noop */ }
    if (res.status === 401) return { status: 'auth', message: 'That API key was rejected — check it and try again.' };
    if (res.status === 429) return { status: 'ratelimit', message: 'Rate limited by the API — wait a moment and try again.' };
    if (res.status >= 500) return { status: 'overloaded', message: 'The API is busy right now — try again shortly.' };
    return { status: 'error', message: apiMessage || `Request failed (${res.status}).` };
  }

  const data = await res.json();
  if (data.stop_reason === 'refusal') {
    return { status: 'refusal', message: 'The model declined this request — try rewording the craving.' };
  }
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  let parsed = null;
  try { parsed = JSON.parse(textBlock?.text ?? ''); } catch { /* handled below */ }
  const recipe = parsed ? mapGenerated(parsed) : null;
  if (!recipe) return { status: 'error', message: 'The response couldn’t be read as a recipe — try again.' };
  return { status: 'ok', recipe };
}
