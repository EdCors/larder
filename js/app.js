/* App shell: tabs, view switching, service worker registration. */

import { openDB } from './db.js';
import { $, el, toast } from './ui.js';
import { pantryView } from './views/pantry.js';
import { recipesView } from './views/recipes.js';
import { planView } from './views/plan.js';
import { trackView } from './views/track.js';
import { insightsView } from './views/insights.js';

const ICONS = {
  jar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="7.5" y="3" width="9" height="3" rx="1.5"/><rect x="5.5" y="8.5" width="13" height="12.5" rx="3"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="16" rx="3"/><path d="M3.5 10h17M8 2.5V6M16 2.5V6"/></svg>',
  pulse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2.5-7 4.5 14 2.5-7H21"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 20v-7M12 20V5M19 20v-11"/></svg>',
};

const TABS = [
  { id: 'pantry',   label: 'Pantry',   icon: ICONS.jar,      title: 'Larder',    view: pantryView },
  { id: 'recipes',  label: 'Recipes',  icon: ICONS.book,     title: 'Recipes',   view: recipesView },
  { id: 'plan',     label: 'Plan',     icon: ICONS.calendar, title: 'Meal plan', view: planView },
  { id: 'track',    label: 'Track',    icon: ICONS.pulse,    title: 'Nutrition', view: trackView },
  { id: 'insights', label: 'Insights', icon: ICONS.chart,    title: 'Insights',  view: insightsView },
];

let currentTab = null;

const ctx = {
  setSubtitle(text) { $('#headerSub').textContent = text || ''; },
  setActions(node) {
    const slot = $('#headerActions');
    slot.innerHTML = '';
    if (node) slot.append(node);
  },
};

function placeholder(tab) {
  return el('div', { class: 'placeholder' },
    el('div', { html: tab.icon }),
    el('h3', {}, tab.title),
    el('p', {}, `Coming in ${tab.phase}.`)
  );
}

export function switchTab(id) {
  if (currentTab === id) return;
  currentTab = id;
  const tab = TABS.find((t) => t.id === id);

  for (const btn of document.querySelectorAll('.tab')) {
    btn.classList.toggle('active', btn.dataset.tab === id);
  }
  $('#headerTitle').textContent = tab.title;
  ctx.setSubtitle('');
  ctx.setActions(null);

  const view = $('#view');
  view.innerHTML = '';
  view.scrollTop = 0;

  const fab = $('#fab');
  if (tab.view) {
    fab.hidden = !tab.view.onFab;
    tab.view.mount(view, ctx);
  } else {
    fab.hidden = true;
    view.append(placeholder(tab));
  }
}

function buildTabbar() {
  const bar = $('#tabbar');
  for (const tab of TABS) {
    bar.append(
      el('button', { class: 'tab', dataset: { tab: tab.id }, onclick: () => switchTab(tab.id) },
        el('span', { html: tab.icon }),
        tab.label
      )
    );
  }
}

async function boot() {
  buildTabbar();
  $('#fab').addEventListener('click', () => {
    const tab = TABS.find((t) => t.id === currentTab);
    if (tab && tab.view && tab.view.onFab) tab.view.onFab();
  });
  try {
    await openDB();
  } catch (err) {
    console.error('IndexedDB unavailable', err);
  }
  switchTab('pantry');

  if ('serviceWorker' in navigator) {
    // Only an update produces a controllerchange while a controller already
    // exists — first installs don't trigger the toast.
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) {
        toast('Larder updated — reopen the app to finish', { duration: 8000 });
      }
    });
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW registration failed', err));
  }
}

boot();
