// ════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════

const DEFAULT_STORES = [
  { id: 'grocery_main', name: 'Supermarkt', type: 'supermarket' },
  { id: 'dm_main',      name: 'DM',         type: 'drugstore' }
];

const STORE_TYPES = [
  { value: 'supermarket', label: 'Supermarket' },
  { value: 'drugstore',   label: 'Drugstore' },
  { value: 'pharmacy',    label: 'Pharmacy' },
  { value: 'other',       label: 'Other' },
];

let state = {
  items: [],
  currentStoreId: 'grocery_main',
  session: { id: uid(), storeId: 'grocery_main', order: [] },
  ordered: false
};

let history = {};
let recipes = [];
let storeRegistry = [];
let currentView = 'list';
let reorderMode  = false;
let pendingZone  = null;
let unknownSectionOpen = false;

// Pointer drag state (ephemeral, never persisted)
let dragEl     = null;
let dragClone  = null;
let dragOffY   = 0;

// Most recently added item id — consumed once by the next render() to stamp
// data-new="true" for the highlightFade animation, then cleared.
let lastAddedId = null;

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function nameKey(name) {
  return name.toLowerCase().trim();
}

// ════════════════════════════════════════════
// PERSISTENCE
// ════════════════════════════════════════════

const STORAGE_KEY  = 'marketlist_v2';
const HISTORY_KEY  = 'itemHistory';
const RECIPES_KEY  = 'recipes';
const STORES_KEY   = 'storeRegistry';

function migrateHistoryIfNeeded() {
  let needsMigration = false;
  for (const key in history) {
    if ('zone' in history[key] || 'hist' in history[key]) {
      needsMigration = true;
      break;
    }
  }
  if (!needsMigration) return false;

  for (const key in history) {
    const h = history[key];
    if (('zone' in h || 'hist' in h) && !h.stores) {
      const zone = h.zone ?? null;
      const hist = h.hist || [];
      history[key] = {
        displayName: h.displayName || null,
        comments: h.comments || [],
        stores: { grocery_main: { zone, hist } },
        notAt: []
      };
    } else {
      if (!h.stores)   h.stores   = {};
      if (!h.notAt)    h.notAt    = [];
      if (!h.comments) h.comments = [];
    }
  }
  return true;
}

function load() {
  // Load history
  try {
    const rawH = localStorage.getItem(HISTORY_KEY);
    if (rawH) history = JSON.parse(rawH);
  } catch (_) {}

  // Load state
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const rawItems = parsed.items || [];
      let migrated = false;
      state.items = rawItems.map(item => {
        // Migrate old items that stored zone/hist inline on the item object
        if (item.zone != null || (item.hist && item.hist.length > 0)) {
          const key = nameKey(item.name);
          if (!history[key]) {
            history[key] = { displayName: item.name, comments: [], stores: { grocery_main: { zone: item.zone ?? null, hist: item.hist || [] } }, notAt: [] };
            migrated = true;
          }
          return { id: item.id, name: item.name, checked: !!item.checked, comment: item.comment || '' };
        }
        return { id: item.id, name: item.name, checked: !!item.checked, comment: item.comment || '' };
      });
      if (migrated) saveHistory();
      state.currentStoreId = parsed.currentStoreId || 'grocery_main';
      state.session = parsed.session || { id: uid(), storeId: 'grocery_main', order: [] };
      if (!state.session.storeId) state.session.storeId = 'grocery_main';
      state.ordered = parsed.ordered || false;
    }
  } catch (_) {}

  // Migrate history from old flat shape to store-scoped shape
  try { if (migrateHistoryIfNeeded()) saveHistory(); } catch (_) {}

  // Load recipes
  try {
    const rawR = localStorage.getItem(RECIPES_KEY);
    if (rawR) recipes = JSON.parse(rawR);
  } catch (_) {}

  // Load store registry (create defaults if absent)
  try {
    const rawS = localStorage.getItem(STORES_KEY);
    if (rawS) {
      storeRegistry = JSON.parse(rawS);
    } else {
      storeRegistry = DEFAULT_STORES.map(s => ({ ...s }));
      saveStores();
    }
  } catch (_) {
    storeRegistry = DEFAULT_STORES.map(s => ({ ...s }));
    saveStores();
  }

  // One-time migration: legacy 'grocery' type becomes 'supermarket'.
  if (storeRegistry.some(s => s.type === 'grocery')) {
    storeRegistry.forEach(s => { if (s.type === 'grocery') s.type = 'supermarket'; });
    saveStores();
  }

  // One-time migration: sort existing items by score so the stored order is meaningful
  if (!state.ordered) {
    state.items = sorted(state.items, state.currentStoreId);
    state.ordered = true;
    saveState();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    items: state.items,
    currentStoreId: state.currentStoreId,
    session: state.session,
    ordered: state.ordered
  }));
}

function saveHistory() {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

function saveStores() {
  localStorage.setItem(STORES_KEY, JSON.stringify(storeRegistry));
}

function saveRecipes() {
  localStorage.setItem(RECIPES_KEY, JSON.stringify(recipes));
}

// ════════════════════════════════════════════
// SCORING
// ════════════════════════════════════════════
// Note: sorted() is used only for the one-time migration sort in load().
// render() uses state.items order directly from this point on.

// Trip history is exponentially decayed by weeks of age so recent trips
// dominate the score and the model adapts quickly when a store rearranges.
// Synthetic entries (produced by history compaction) carry a baked-in
// weight that already encodes the decay accumulated up to compaction time;
// score() applies further decay based on the synth's recordedAt age on top.
const DECAY_RATE    = 0.95;                  // per-week multiplicative decay
const WEEK_MS       = 7 * 24 * 60 * 60 * 1000;
const MAX_RAW_TRIPS = 20;                    // compaction trigger threshold

// score() returns a 0..1 position estimate for `item` at `storeId`. Shape and
// signature are unchanged. Internally it averages per-trip positions weighted
// by DECAY_RATE^weeks_since_trip. Legacy entries without `recordedAt` are
// treated as weight 1.0. Synthetic entries contribute (weight * decay) to
// both numerator and denominator — their weight already encodes decay up to
// compaction time, and we apply additional decay on top based on age.
function score(item, storeId) {
  const h = history[nameKey(item.name)];
  const sh = h?.stores?.[storeId];
  if (sh && sh.hist && sh.hist.length >= 2) {
    const now = Date.now();
    let num = 0, den = 0;
    for (const e of sh.hist) {
      if (e.synthetic) {
        const ageWeeks = e.recordedAt ? Math.max(0, (now - e.recordedAt) / WEEK_MS) : 0;
        const w = e.weight * Math.pow(DECAY_RATE, ageWeeks);
        num += e.position * w;
        den += w;
      } else {
        const w = e.recordedAt
          ? Math.pow(DECAY_RATE, Math.max(0, (now - e.recordedAt) / WEEK_MS))
          : 1.0;
        num += e.pos * w;
        den += w;
      }
    }
    return den > 0 ? num / den : 0;
  }
  if (sh && sh.zone != null) return sh.zone;
  return 1.0;
}

// Compact the oldest entries of a per-item-per-store `hist` array into a
// single synthetic entry so storage stays bounded. The synthetic entry's
// `weight` is the sum of effective (decayed) weights of the entries it
// replaces, and its `recordedAt` is the newest timestamp among them
// (null if none of the merged entries had timestamps).
//
// We compact however many oldest entries are needed to leave exactly
// floor(MAX_RAW_TRIPS / 2) = 10 raw entries at the tail, plus the 1 new
// synthetic at the head. This keeps total length at 11 after every compaction
// regardless of how many raw entries had accumulated.
//
// Trace for 25 trips on one item/store (MAX_RAW_TRIPS = 20):
//   After push 1..20:  length grows 1..20, no compaction (20 > 20 is false).
//   After push 21:     length = 21, compact 21 - 10 = 11 oldest into 1 synth
//                      -> [synth, t12..t21]  = 1 synth + 10 raw = 11 entries.
//   After push 22..30: length grows 12..20, no compaction.
//   After push 31:     length = 21 (1 synth + 20 raw), compact 11 oldest
//                      (the existing synth + 10 oldest raw) into 1 new synth
//                      -> [synth', t22..t31] = 1 synth + 10 raw = 11 entries.
function compactHistory(histArr) {
  const KEEP_RAW = Math.floor(MAX_RAW_TRIPS / 2); // 10
  if (histArr.length <= MAX_RAW_TRIPS) return;
  const toCompactCount = histArr.length - KEEP_RAW;
  const head = histArr.slice(0, toCompactCount);
  const now = Date.now();
  let num = 0, den = 0;
  let newestTs = 0;
  for (const e of head) {
    let w, pos;
    if (e.synthetic) {
      const ageWeeks = e.recordedAt ? Math.max(0, (now - e.recordedAt) / WEEK_MS) : 0;
      w   = e.weight * Math.pow(DECAY_RATE, ageWeeks);
      pos = e.position;
    } else {
      w = e.recordedAt
        ? Math.pow(DECAY_RATE, Math.max(0, (now - e.recordedAt) / WEEK_MS))
        : 1.0;
      pos = e.pos;
    }
    num += pos * w;
    den += w;
    if (e.recordedAt && e.recordedAt > newestTs) newestTs = e.recordedAt;
  }
  histArr.splice(0, toCompactCount, {
    position:   den > 0 ? num / den : 0,
    weight:     den,
    recordedAt: newestTs > 0 ? newestTs : null,
    synthetic:  true,
  });
}

function indicator(item, storeId) {
  const h = history[nameKey(item.name)];
  const sh = h?.stores?.[storeId];
  if (sh && sh.hist && sh.hist.length >= 2) {
    return { cls: 'hist', label: '●', tip: `${sh.hist.length} trips` };
  }
  if (sh && sh.zone != null) {
    const names = { 0.1: 'ENT', 0.4: 'MID', 0.7: 'BCK', 0.9: 'CHK' };
    return { cls: 'zone', label: names[sh.zone] ?? '~', tip: 'zone estimate' };
  }
  const inferredFrom = getInferredStore(item, storeId);
  if (inferredFrom) {
    const src = storeRegistry.find(s => s.id === inferredFrom);
    const shortName = (src?.name || '').slice(0, 3) || '?';
    return { cls: 'inferred', label: `~${shortName}`, tip: `Inferred from ${src?.name || 'another store'}` };
  }
  return { cls: 'none', label: '—', tip: 'no data' };
}

function sorted(items, storeId) {
  return [...items].sort((a, b) => {
    if (a.checked !== b.checked) return a.checked ? 1 : -1;
    return score(a, storeId) - score(b, storeId);
  });
}

function getAvailability(item, storeId) {
  if (!storeId) return 'unknown';
  const h = history[nameKey(item.name)];
  if (h && h.notAt && h.notAt.includes(storeId)) return 'unavailable';
  if (h && h.stores && h.stores[storeId]) return 'known';
  return 'unknown';
}

// If item is unknown at `storeId` but explicitly known at another store of the
// same type (and not on `notAt`), return that source storeId so callers can
// surface an inferred-availability badge. Otherwise null.
function getInferredStore(item, storeId) {
  const h = history[nameKey(item.name)];
  if (h && h.notAt && h.notAt.includes(storeId)) return null;
  if (getAvailability(item, storeId) === 'known') return null;
  const currentStore = storeRegistry.find(s => s.id === storeId);
  if (!currentStore || currentStore.type === 'other') return null;
  const sameType = storeRegistry.filter(s => s.id !== storeId && s.type === currentStore.type);
  for (const s of sameType) {
    if (getAvailability(item, s.id) === 'known') return s.id;
  }
  return null;
}

// ════════════════════════════════════════════
// ACTIONS — list
// ════════════════════════════════════════════

// Insert item at the position its score suggests among unchecked items.
// Checked items stay at the end in their current relative order.
function insertItem(item) {
  const storeId = state.currentStoreId;
  const newScore = score(item, storeId);
  const unchecked = state.items.filter(i => !i.checked);
  const checked   = state.items.filter(i => i.checked);
  let at = unchecked.length;
  for (let i = 0; i < unchecked.length; i++) {
    if (score(unchecked[i], storeId) > newScore) { at = i; break; }
  }
  unchecked.splice(at, 0, item);
  state.items = [...unchecked, ...checked];
}

function addItem(name, zone) {
  name = name.trim();
  if (!name) return false;

  const key = nameKey(name);
  const storeId = state.currentStoreId;
  let histChanged = false;

  if (!history[key]) {
    history[key] = { displayName: name, comments: [], stores: {}, notAt: [] };
    histChanged = true;
  } else {
    if (!history[key].displayName) { history[key].displayName = name; histChanged = true; }
    if (!history[key].stores)      { history[key].stores = {};         histChanged = true; }
    if (!history[key].notAt)       { history[key].notAt = [];          histChanged = true; }
    if (!history[key].comments)    { history[key].comments = [];       histChanged = true; }
  }

  if (!history[key].stores[storeId]) {
    history[key].stores[storeId] = { zone: null, hist: [] };
    histChanged = true;
  }

  const notAtIdx = history[key].notAt.indexOf(storeId);
  if (notAtIdx !== -1) {
    history[key].notAt.splice(notAtIdx, 1);
    histChanged = true;
  }

  if (zone != null) {
    if (history[key].stores[storeId].zone == null) {
      history[key].stores[storeId].zone = zone;
      histChanged = true;
    }
  }

  if (histChanged) saveHistory();

  const existing = state.items.find(i => nameKey(i.name) === key);
  if (existing) {
    showToast(`${existing.name} is already on the list`);
  } else {
    const newItem = { id: uid(), name, checked: false, comment: '' };
    insertItem(newItem);
    lastAddedId = newItem.id;
  }
  if (!state.ordered) state.ordered = true;
  saveState();
  render();
  return true;
}

function toggleItem(id) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  if (!item.checked) {
    item.checked = true;
    if (!state.session.order.includes(id)) state.session.order.push(id);
    // Defer the destructive re-render so the row can play its collapse
    // animation in place — mirrors the pattern used in removeItem().
    const el = document.querySelector(`.item[data-id="${id}"]`);
    if (el) {
      el.classList.add('checking');
      setTimeout(() => { saveState(); render(); }, 200);
    } else {
      saveState();
      render();
    }
  } else {
    item.checked = false;
    state.session.order = state.session.order.filter(x => x !== id);
    saveState();
    render();
  }
}

function removeItem(id) {
  const el = document.querySelector(`.item[data-id="${id}"]`);
  if (el) {
    el.classList.add('removing');
    el.addEventListener('animationend', () => {
      state.items = state.items.filter(i => i.id !== id);
      state.session.order = state.session.order.filter(x => x !== id);
      saveState();
      render();
    }, { once: true });
  } else {
    state.items = state.items.filter(i => i.id !== id);
    saveState();
    render();
  }
}

// recordTrip() saves each checked item's position in the trip to its per-store
// hist array as a raw entry { sid, pos, recordedAt }, then runs compactHistory
// on that array so it can never grow past MAX_RAW_TRIPS + 1 entries on disk.
// Existing entries without `recordedAt` continue to work — score() treats
// them as weight 1.0 and compactHistory folds them in at weight 1.0.
function recordTrip() {
  const sessionStoreId = state.session.storeId || 'grocery_main';
  const order = state.session.order;
  const n = order.length;
  const recordedAt = Date.now();
  let histChanged = false;

  if (n > 0) {
    const sid = state.session.id;
    order.forEach((id, idx) => {
      const item = state.items.find(i => i.id === id);
      if (!item) return;
      const key = nameKey(item.name);
      if (!history[key]) {
        history[key] = { displayName: item.name, comments: [], stores: {}, notAt: [] };
      } else {
        if (!history[key].stores)      history[key].stores  = {};
        if (!history[key].comments)    history[key].comments = [];
        if (!history[key].notAt)       history[key].notAt   = [];
        if (!history[key].displayName) history[key].displayName = item.name;
      }
      if (!history[key].stores[sessionStoreId]) {
        history[key].stores[sessionStoreId] = { zone: null, hist: [] };
      }
      const histArr = history[key].stores[sessionStoreId].hist;
      histArr.push({ sid, pos: (idx + 1) / n, recordedAt });
      compactHistory(histArr);
      histChanged = true;
    });
  }

  state.items.forEach(item => {
    const comment = (item.comment || '').trim();
    if (!comment) return;
    const key = nameKey(item.name);
    if (!history[key]) {
      history[key] = { displayName: item.name, comments: [], stores: {}, notAt: [] };
    }
    if (!history[key].comments) history[key].comments = [];
    if (!history[key].comments.includes(comment)) {
      history[key].comments.push(comment);
      histChanged = true;
    }
  });

  if (histChanged) saveHistory();

  state.items = state.items.filter(i => !i.checked);
  state.session = { id: uid(), storeId: state.currentStoreId, order: [] };
  saveState();
  render();
  showToast(n > 0 ? `Trip recorded — ${n} item${n !== 1 ? 's' : ''} learned` : 'List reset');
}

// ════════════════════════════════════════════
// ACTIONS — recipes
// ════════════════════════════════════════════

function createRecipe() {
  const r = { id: uid(), name: 'New Recipe', items: [], type: 'main' };
  recipes.unshift(r);
  saveRecipes();
  renderRecipes();
  setTimeout(() => {
    openRecipePanel(r.id);
    setRecipeEditing(r.id, true);
    const nameInput = document.querySelector(`.recipe-name-input[data-recipe-id="${r.id}"]`);
    if (nameInput) { nameInput.focus(); nameInput.select(); }
  }, 60);
}

function deleteRecipe(id) {
  recipes = recipes.filter(r => r.id !== id);
  saveRecipes();
  renderRecipes();
}

function renameRecipe(id, newName) {
  const r = recipes.find(r => r.id === id);
  if (!r) return;
  const trimmed = newName.trim();
  if (trimmed) r.name = trimmed;
  saveRecipes();
  const nameEl = document.querySelector(`.recipe[data-recipe-id="${id}"] .recipe-name-text`);
  if (nameEl) nameEl.textContent = r.name;
  const countEl = document.querySelector(`.recipe[data-recipe-id="${id}"] .recipe-item-count`);
  if (countEl) countEl.textContent = recipeCountLabel(r);
}

function addRecipeItem(recipeId, name, amount) {
  name = name.trim();
  if (!name) return false;
  const r = recipes.find(r => r.id === recipeId);
  if (!r) return false;
  r.items.push({ id: uid(), name, amount: amount.trim() });
  saveRecipes();
  refreshRecipeItemsDOM(recipeId);
  return true;
}

function removeRecipeItem(recipeId, itemId) {
  const r = recipes.find(r => r.id === recipeId);
  if (!r) return;
  r.items = r.items.filter(i => i.id !== itemId);
  saveRecipes();
  refreshRecipeItemsDOM(recipeId);
}

function addRecipeToList(recipeId) {
  const r = recipes.find(r => r.id === recipeId);
  if (!r) return;
  if (r.items.length === 0) { showToast('Recipe has no items'); return; }

  // Collect selected item IDs from the DOM (all default to selected; resets on re-render)
  const panel = document.getElementById(`recipe-panel-${recipeId}`);
  const selectedIds = new Set();
  if (panel) {
    panel.querySelectorAll('.recipe-item-cb.active').forEach(btn => selectedIds.add(btn.dataset.riToggle));
  } else {
    r.items.forEach(i => selectedIds.add(i.id));
  }

  const itemsToAdd = r.items.filter(i => selectedIds.has(i.id));
  if (itemsToAdd.length === 0) { showToast('No items selected'); return; }

  itemsToAdd.forEach(ri => {
    const key = nameKey(ri.name);
    const existing = state.items.find(i => nameKey(i.name) === key);
    if (existing) {
      if (ri.amount) {
        existing.comment = existing.comment
          ? existing.comment + ', ' + ri.amount
          : ri.amount;
      }
    } else {
      insertItem({ id: uid(), name: ri.name, checked: false, comment: ri.amount || '' });
    }
  });

  saveState();
  currentView = 'list';
  renderView();
  const n = itemsToAdd.length;
  const msg = n === r.items.length
    ? `${r.name} added to list`
    : `${r.name} — ${n} of ${r.items.length} items added`;
  showToast(msg);
}

// ════════════════════════════════════════════
// RENDER — list
// ════════════════════════════════════════════

function renderStoreSwitcher() {
  const el = document.getElementById('storeSwitcher');
  if (!el) return;
  if (currentView === 'recipes') {
    el.classList.add('store-switcher--recipes');
    el.innerHTML = `<button class="new-recipe-btn" data-new-recipe>+ NEW RECIPE</button>`;
    return;
  }
  el.classList.remove('store-switcher--recipes');
  const pills = storeRegistry.map(s =>
    `<button class="store-pill${s.id === state.currentStoreId ? ' active' : ''}" data-switch-store="${esc(s.id)}">${esc(s.name)}</button>`
  ).join('');
  el.innerHTML = pills +
    `<button class="store-add-pill" data-add-store aria-label="Add store">+</button>`;
}

// Transient state while the inline add-store form is open.
let addingStoreType = 'supermarket';

const STORE_TYPE_SHORT = {
  supermarket: 'SUPER',
  drugstore:   'DRUG',
  pharmacy:    'PHARM',
  other:       'OTHER',
};

function showAddStoreForm() {
  const el = document.getElementById('storeSwitcher');
  if (!el) return;
  addingStoreType = 'supermarket';
  const typeBtns = STORE_TYPES.map(t =>
    `<button class="store-add-type-opt${t.value === addingStoreType ? ' active' : ''}" data-store-form-type="${t.value}">${STORE_TYPE_SHORT[t.value]}</button>`
  ).join('');
  el.innerHTML = `
    <div class="store-add-form">
      <input class="store-add-name" type="text" placeholder="Store name…" maxlength="30"
        autocomplete="off" autocorrect="off" autocapitalize="words" spellcheck="false">
      <div class="store-add-type-row">${typeBtns}</div>
      <button class="store-add-confirm" data-store-form-confirm aria-label="Add">✓</button>
      <button class="store-add-cancel" data-store-form-cancel aria-label="Cancel">✕</button>
    </div>`;
  const input = el.querySelector('.store-add-name');
  if (input) input.focus();
}

function confirmAddStoreFromForm() {
  const el = document.getElementById('storeSwitcher');
  if (!el) return;
  const input = el.querySelector('.store-add-name');
  if (!input) return;
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  const newStore = { id: 'store_' + uid(), name, type: addingStoreType };
  storeRegistry.push(newStore);
  saveStores();
  state.currentStoreId = newStore.id;
  state.items = sorted(state.items, newStore.id);
  unknownSectionOpen = false;
  saveState();
  renderStoreSwitcher();
  render();
  showToast('Store added');
}

function cancelAddStoreForm() {
  renderStoreSwitcher();
}

function switchStore(id) {
  if (id === state.currentStoreId) return;
  state.currentStoreId = id;
  state.items = sorted(state.items, id);
  unknownSectionOpen = false;
  saveState();
  renderStoreSwitcher();
  render();
}

function toggleAvailability(itemId, storeId) {
  const item = state.items.find(i => i.id === itemId);
  if (!item) return;
  const key = nameKey(item.name);
  if (!history[key]) {
    history[key] = { displayName: item.name, comments: [], stores: {}, notAt: [] };
  }
  if (!history[key].notAt) history[key].notAt = [];
  const idx = history[key].notAt.indexOf(storeId);
  if (idx >= 0) {
    history[key].notAt.splice(idx, 1);
  } else {
    history[key].notAt.push(storeId);
  }
  saveHistory();
  render();
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function itemHtml(item, draggable = true) {
  const storeId   = state.currentStoreId;
  const store     = storeRegistry.find(s => s.id === storeId);
  const storeName = store ? store.name : 'this store';
  const ind       = indicator(item, storeId);
  const inReorder = draggable && reorderMode && !item.checked;
  const cls = [
    'item',
    item.checked ? 'checked' : '',
    inReorder ? 'reorder-mode' : ''
  ].filter(Boolean).join(' ');
  const comment = item.comment || '';
  const h = history[nameKey(item.name)] || {};
  const pastComments = h.comments || [];
  const isUnavail = !!(h.notAt && h.notAt.includes(storeId));
  const availBtnHtml = item.checked ? '' : `
        <button class="avail-btn${isUnavail ? ' is-unavailable' : ''}" data-avail-toggle="${item.id}">${isUnavail ? `Mark as available at ${esc(storeName)}` : `Not sold at ${esc(storeName)}`}</button>`;

  const commentText = comment
    ? `<span class="item-comment">${esc(comment)}</span>`
    : '';

  const noteBtnCls = comment ? 'note-btn has-note' : 'note-btn';

  const chipsHtml = pastComments.length > 0
    ? `<div class="note-chips">${pastComments.map(c =>
        `<span class="note-chip" data-chip="${esc(c)}" data-item-id="${item.id}">${esc(c)}</span>`
      ).join('')}</div>`
    : '';

  const dragHandleHtml = inReorder ? `
        <div class="drag-handle" aria-hidden="true">
          <svg width="14" height="11" viewBox="0 0 14 11" fill="none">
            <line x1="0" y1="1.5" x2="14" y2="1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <line x1="0" y1="5.5" x2="14" y2="5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <line x1="0" y1="9.5" x2="14" y2="9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </div>` : '';

  const newAttr = item.id === lastAddedId ? ' data-new="true"' : '';

  return `
    <div class="${cls}" data-id="${item.id}"${newAttr}>
      <div class="item-main">
        ${dragHandleHtml}
        <div class="cb" data-toggle="${item.id}" role="checkbox" aria-checked="${item.checked}" aria-label="Toggle ${esc(item.name)}">
          <svg width="13" height="10" viewBox="0 0 13 10" fill="none">
            <polyline points="1.5,5 5,8.5 11,1.5" stroke="#5dd780" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <div class="item-text">
          <span class="item-name">${esc(item.name)}</span>
          ${commentText}
        </div>
        <span class="sort-badge ${ind.cls}" title="${ind.tip}">${ind.label}</span>
        <button class="${noteBtnCls}" data-note="${item.id}" aria-label="Add note to ${esc(item.name)}">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
            <path d="M7.5 1.5L9.5 3.5M1.5 9.5L2.5 6.5L7.5 1.5L9.5 3.5L4.5 8.5L1.5 9.5Z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button class="del-btn" data-delete="${item.id}" aria-label="Remove ${esc(item.name)}">×</button>
      </div>
      <div class="item-note-panel" id="note-panel-${item.id}">
        ${chipsHtml}
        <input
          class="note-input"
          id="note-input-${item.id}"
          data-item-id="${item.id}"
          type="text"
          placeholder="add a note..."
          maxlength="40"
          value="${esc(comment)}"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
        >
        ${availBtnHtml}
      </div>
    </div>`;
}

function render() {
  const storeId = state.currentStoreId;
  const all     = state.items;
  const checked = all.filter(i => i.checked);

  const unchecked    = all.filter(i => !i.checked);
  const knownItems   = unchecked.filter(i => getAvailability(i, storeId) === 'known');
  const unknownRaw   = unchecked.filter(i => getAvailability(i, storeId) === 'unknown');
  const inferredItems = unknownRaw.filter(i => getInferredStore(i, storeId) !== null);
  const unknownItems  = unknownRaw.filter(i => getInferredStore(i, storeId) === null);
  // "To Get" = known items, then inferred items at the tail (score 0.95 region,
  // just before truly unknown items in the collapsible section).
  const toGetItems = [...knownItems, ...inferredItems];
  // unavailable items are not rendered

  const total = all.length;

  // Reorder button: show only when ≥2 confirmed-known items; inferred and
  // unknown items are excluded from drag-reorder because their positions
  // aren't trustworthy data for this store.
  const reorderBtn = document.getElementById('reorderBtn');
  if (reorderBtn && currentView === 'list') {
    const show = knownItems.length > 1;
    reorderBtn.style.display = show ? 'flex' : 'none';
    if (!show && reorderMode) {
      reorderMode = false;
      reorderBtn.classList.remove('active');
    }
  }

  const badge = document.getElementById('tripBadge');
  badge.textContent = total > 0 ? `${checked.length} / ${total}` : '';

  const doneBtn = document.getElementById('doneBtn');
  doneBtn.disabled = checked.length === 0;
  doneBtn.textContent = checked.length > 0
    ? `DONE SHOPPING  (${checked.length})`
    : 'DONE SHOPPING';

  const root = document.getElementById('listRoot');

  if (total === 0) {
    root.innerHTML = `
      <div class="empty">
        <div class="empty-glyph">EMPTY</div>
        <div class="empty-msg">Your list is empty.<br>Add items above to get started.</div>
      </div>`;
    return;
  }

  let html = '';

  // To-Get section: confirmed-known items first, inferred items tacked on at the end
  if (toGetItems.length > 0) {
    html += `<div class="list-section">`;
    if (checked.length > 0 || unknownItems.length > 0) {
      html += `
        <div class="section-header">
          <span class="section-label">to get</span>
          <span class="section-count">${toGetItems.length}</span>
          <span class="section-line"></span>
        </div>`;
    }
    html += toGetItems.map(item => itemHtml(item)).join('');
    html += `</div>`;
  }

  // Unknown availability collapsible section
  if (unknownItems.length > 0) {
    html += `
      <details class="unknown-section"${unknownSectionOpen ? ' open' : ''}>
        <summary>
          <span class="section-label">Unknown availability</span>
          <span class="section-count">${unknownItems.length}</span>
          <span class="section-line"></span>
          <span class="unknown-toggle-icon">▾</span>
        </summary>
        ${unknownItems.map(i => itemHtml(i, false)).join('')}
      </details>`;
  }

  // In-cart section
  if (checked.length > 0) {
    html += `<div class="list-section">
      <div class="section-header">
        <span class="section-label">in cart</span>
        <span class="section-count">${checked.length}</span>
        <span class="section-line"></span>
      </div>`;
    html += checked.map(item => itemHtml(item)).join('');
    html += `</div>`;
  }

  root.innerHTML = html;
  lastAddedId = null;

  // Persist open/closed state across re-renders
  const detailsEl = root.querySelector('.unknown-section');
  if (detailsEl) {
    detailsEl.addEventListener('toggle', () => {
      unknownSectionOpen = detailsEl.open;
    });
  }
}

// ════════════════════════════════════════════
// RENDER — recipes
// ════════════════════════════════════════════

function recipeCountLabel(r) {
  return r.items.length === 0 ? 'empty' : `${r.items.length} item${r.items.length !== 1 ? 's' : ''}`;
}

function recipeItemsListHtml(r) {
  if (r.items.length === 0) return '';
  return r.items.map(item => `
    <div class="recipe-item-row">
      <button class="recipe-item-cb active" data-ri-toggle="${esc(item.id)}" data-recipe-id="${r.id}" aria-label="Toggle ${esc(item.name)}">
        <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
          <polyline points="1,3.5 3.5,6 8,1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <span class="recipe-item-name">${esc(item.name)}</span>
      ${item.amount ? `<span class="recipe-item-amount">${esc(item.amount)}</span>` : ''}
      <button class="recipe-item-remove" data-remove-item="${item.id}" data-recipe-id="${r.id}">×</button>
    </div>`).join('');
}

function recipeHtml(r) {
  return `
    <div class="recipe" data-recipe-id="${r.id}">
      <div class="recipe-header" data-toggle-recipe="${r.id}">
        <div class="recipe-name-area">
          <span class="recipe-name-text">${esc(r.name)}</span>
          <span class="recipe-item-count">${recipeCountLabel(r)}</span>
        </div>
        <button class="recipe-add-btn" data-recipe-add="${r.id}">+ LIST</button>
        <button class="recipe-edit-btn" data-recipe-edit-toggle="${r.id}">EDIT</button>
        <button class="recipe-done-btn" data-recipe-edit-toggle="${r.id}">DONE</button>
        <button class="recipe-del-btn" data-recipe-del="${r.id}">×</button>
      </div>
      <div class="recipe-panel" id="recipe-panel-${r.id}">
        <input class="recipe-name-input" data-recipe-id="${r.id}" type="text"
          value="${esc(r.name)}" maxlength="50" placeholder="Recipe name..."
          autocomplete="off" spellcheck="false">
        <div class="recipe-type-toggle">
          <span class="recipe-type-toggle-label">type</span>
          <button class="recipe-type-opt recipe-type-main${(r.type || 'main') !== 'dessert' ? ' active' : ''}" data-recipe-set-type="main" data-recipe-id="${r.id}">MAIN</button>
          <button class="recipe-type-opt recipe-type-dessert${r.type === 'dessert' ? ' active' : ''}" data-recipe-set-type="dessert" data-recipe-id="${r.id}">DESSERT</button>
        </div>
        <div class="recipe-items-list">${recipeItemsListHtml(r)}</div>
        <div class="recipe-add-row">
          <div class="recipe-ingredient-wrap">
            <input class="recipe-ingredient-input" data-recipe-id="${r.id}" type="text"
              placeholder="ingredient..." maxlength="60"
              autocomplete="off" autocorrect="off" autocapitalize="words" spellcheck="false">
            <div class="ac-list recipe-ac" id="recipe-ac-${r.id}"></div>
          </div>
          <input class="recipe-amount-input" data-recipe-id="${r.id}" type="text"
            placeholder="amount" maxlength="20" autocomplete="off">
          <button class="recipe-item-submit" data-recipe-submit="${r.id}">ADD</button>
        </div>
      </div>
    </div>`;
}

function renderRecipes() {
  const root = document.getElementById('recipesRoot');

  if (recipes.length === 0) {
    root.innerHTML = `
      <div class="recipes-empty">
        <div class="recipes-empty-glyph">RECIPES</div>
        <div class="recipes-empty-msg">No recipes yet.<br>Create one to quickly add items to your list.</div>
      </div>`;
  } else {
    const mains    = recipes.filter(r => (r.type || 'main') !== 'dessert');
    const desserts = recipes.filter(r => r.type === 'dessert');
    const hasGroups = mains.length > 0 && desserts.length > 0;

    const sectionHeader = (label, count, variant) => `
      <div class="section-header recipe-section-header recipe-section-${variant}">
        <span class="section-label">${label}</span>
        <span class="section-count">${count}</span>
        <span class="section-line"></span>
      </div>`;

    let body = '';
    if (mains.length > 0) {
      if (hasGroups) body += sectionHeader('main dishes', mains.length, 'main');
      body += mains.map(recipeHtml).join('');
    }
    if (desserts.length > 0) {
      if (hasGroups) body += sectionHeader('desserts', desserts.length, 'dessert');
      body += desserts.map(recipeHtml).join('');
    }
    root.innerHTML = body;
  }
}

function refreshRecipeItemsDOM(recipeId) {
  const r = recipes.find(r => r.id === recipeId);
  if (!r) return;
  const panel = document.getElementById(`recipe-panel-${recipeId}`);
  if (!panel) return;
  const listEl = panel.querySelector('.recipe-items-list');
  if (listEl) listEl.innerHTML = recipeItemsListHtml(r);
  const countEl = document.querySelector(`.recipe[data-recipe-id="${recipeId}"] .recipe-item-count`);
  if (countEl) countEl.textContent = recipeCountLabel(r);
}

function clearAllRecipeEditing() {
  document.querySelectorAll('.recipe.recipe--editing').forEach(el => el.classList.remove('recipe--editing'));
}

function setRecipeEditing(id, editing) {
  const recipeEl = document.querySelector(`.recipe[data-recipe-id="${id}"]`);
  if (!recipeEl) return;
  recipeEl.classList.toggle('recipe--editing', editing);
}

function openRecipePanel(id) {
  document.querySelectorAll('.recipe-panel.open').forEach(p => p.classList.remove('open'));
  clearAllRecipeEditing();
  const panel = document.getElementById(`recipe-panel-${id}`);
  if (panel) panel.classList.add('open');
}

function toggleRecipePanel(id) {
  const panel = document.getElementById(`recipe-panel-${id}`);
  if (!panel) return;
  const opening = !panel.classList.contains('open');
  document.querySelectorAll('.recipe-panel.open').forEach(p => p.classList.remove('open'));
  clearAllRecipeEditing();
  closeAllRecipeAc();
  if (opening) panel.classList.add('open');
}

// ════════════════════════════════════════════
// RENDER — view switcher
// ════════════════════════════════════════════

function renderView() {
  document.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === currentView);
  });

  const listRoot    = document.getElementById('listRoot');
  const recipesRoot = document.getElementById('recipesRoot');
  const addRow      = document.getElementById('addRow');
  const footer      = document.getElementById('footer');

  if (currentView === 'list') {
    listRoot.style.display = '';
    recipesRoot.classList.remove('visible');
    addRow.style.display = '';
    footer.style.display = '';
    render();
    renderStoreSwitcher();
  } else {
    // Exit reorder mode when leaving the list view
    if (reorderMode) {
      reorderMode = false;
      document.getElementById('reorderBtn').classList.remove('active');
    }
    document.getElementById('reorderBtn').style.display = 'none';
    listRoot.style.display = 'none';
    recipesRoot.classList.add('visible');
    addRow.style.display = 'none';
    zoneRow.classList.remove('visible');
    closeAc();
    footer.style.display = 'none';
    renderStoreSwitcher();
    renderRecipes();
  }
}

// ════════════════════════════════════════════
// TOAST
// ════════════════════════════════════════════

let toastTimer;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function showStorageWarningBanner() {
  if (document.querySelector('.storage-warning-banner')) return;
  const banner = document.createElement('div');
  banner.className = 'storage-warning-banner';
  banner.innerHTML =
    '<span class="swb-msg">Storage full — last change may not have saved. Export a backup to avoid losing data.</span>' +
    '<button class="swb-export" onclick="exportBackup()">Export backup</button>' +
    '<button class="swb-dismiss" aria-label="Dismiss" onclick="this.closest(\'.storage-warning-banner\').remove()">✕</button>';
  document.body.prepend(banner);
}

// ════════════════════════════════════════════
// NOTE PANEL
// ════════════════════════════════════════════

function toggleNote(id) {
  const panel = document.getElementById(`note-panel-${id}`);
  if (!panel) return;
  const opening = !panel.classList.contains('open');
  document.querySelectorAll('.item-note-panel.open').forEach(p => p.classList.remove('open'));
  if (opening) {
    panel.classList.add('open');
    const input = document.getElementById(`note-input-${id}`);
    if (input) setTimeout(() => { input.focus(); input.select(); }, 60);
  }
}

// ════════════════════════════════════════════
// REORDER
// ════════════════════════════════════════════

function toggleReorderMode() {
  reorderMode = !reorderMode;
  const btn = document.getElementById('reorderBtn');
  if (btn) btn.classList.toggle('active', reorderMode);
  render();
}

document.getElementById('reorderBtn').addEventListener('click', toggleReorderMode);

// Pointer drag — fires on listRoot so it only activates inside the list
document.getElementById('listRoot').addEventListener('pointerdown', e => {
  if (!reorderMode) return;
  const handle = e.target.closest('.drag-handle');
  if (!handle) return;

  e.preventDefault();

  const itemEl = handle.closest('.item');
  const rect   = itemEl.getBoundingClientRect();

  // Floating clone follows the pointer
  dragClone = itemEl.cloneNode(true);
  dragClone.classList.remove('drag-ghost', 'reorder-mode');
  Object.assign(dragClone.style, {
    position:   'fixed',
    left:       rect.left + 'px',
    top:        rect.top  + 'px',
    width:      rect.width + 'px',
    zIndex:     '200',
    pointerEvents: 'none',
    boxShadow:  '0 8px 28px rgba(0,0,0,0.6)',
    opacity:    '0.96',
    animation:  'none',
    transition: 'none',
  });
  document.body.appendChild(dragClone);

  itemEl.classList.add('drag-ghost');
  dragEl  = itemEl;
  dragOffY = e.clientY - rect.top;

  document.addEventListener('pointermove', onDragMove, { passive: false });
  document.addEventListener('pointerup',     onDragEnd, { once: true });
  document.addEventListener('pointercancel', onDragEnd, { once: true });
});

function onDragMove(e) {
  if (!dragClone || !dragEl) return;
  e.preventDefault();

  dragClone.style.top = (e.clientY - dragOffY) + 'px';

  // Move ghost within its section to visualise drop position
  const section  = dragEl.parentNode;
  const siblings = Array.from(section.children).filter(
    el => el.classList.contains('item') && el !== dragEl
  );

  let ref = null;
  for (const sib of siblings) {
    const r = sib.getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) { ref = sib; break; }
  }

  if (ref) section.insertBefore(dragEl, ref);
  else      section.appendChild(dragEl);
}

function onDragEnd() {
  document.removeEventListener('pointermove', onDragMove);

  if (!dragEl || !dragClone) return;

  // Read the new order from the DOM and save it into state.items
  const section     = dragEl.parentNode;
  const orderedIds  = Array.from(section.children)
    .filter(el => el.classList.contains('item'))
    .map(el => el.dataset.id);

  const checked = state.items.filter(i => i.checked);
  // Items not in the dragged section (unknown/unavailable items in other DOM containers)
  const notInSection = state.items.filter(i => !i.checked && !orderedIds.includes(i.id));
  const newUnchecked = orderedIds
    .map(id => state.items.find(i => i.id === id))
    .filter(Boolean);

  state.items = [...newUnchecked, ...notInSection, ...checked];

  dragClone.remove();
  dragEl.classList.remove('drag-ghost');
  dragClone = dragEl = null;

  saveState();
  render();
}

// ════════════════════════════════════════════
// EVENTS — list (delegated)
// ════════════════════════════════════════════

document.getElementById('listRoot').addEventListener('click', e => {
  const availBtn = e.target.closest('[data-avail-toggle]');
  if (availBtn) { toggleAvailability(availBtn.dataset.availToggle, state.currentStoreId); return; }

  const noteBtn = e.target.closest('[data-note]');
  if (noteBtn) { toggleNote(noteBtn.dataset.note); return; }

  const chip = e.target.closest('.note-chip');
  if (chip) {
    const id  = chip.dataset.itemId;
    const val = chip.dataset.chip;
    const input = document.getElementById(`note-input-${id}`);
    if (input) {
      input.value = val;
      const item = state.items.find(i => i.id === id);
      if (item) { item.comment = val; saveState(); }
      const commentEl = input.closest('.item').querySelector('.item-comment');
      if (commentEl) commentEl.textContent = val;
      else {
        const nameEl = input.closest('.item').querySelector('.item-name');
        if (nameEl) {
          const span = document.createElement('span');
          span.className = 'item-comment';
          span.textContent = val;
          nameEl.insertAdjacentElement('afterend', span);
        }
      }
      const noteBtn2 = input.closest('.item').querySelector('.note-btn');
      if (noteBtn2) noteBtn2.classList.add('has-note');
      input.focus();
    }
    return;
  }

  const toggleTarget = e.target.closest('[data-toggle]');
  if (toggleTarget) { toggleItem(toggleTarget.dataset.toggle); return; }

  const deleteTarget = e.target.closest('[data-delete]');
  if (deleteTarget) { removeItem(deleteTarget.dataset.delete); }
});

document.getElementById('listRoot').addEventListener('input', e => {
  const noteInput = e.target.closest('.note-input');
  if (!noteInput) return;
  const id = noteInput.dataset.itemId;
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  item.comment = noteInput.value;
  saveState();
  const itemEl = noteInput.closest('.item');
  let commentEl = itemEl.querySelector('.item-comment');
  if (noteInput.value) {
    if (commentEl) {
      commentEl.textContent = noteInput.value;
    } else {
      const nameEl = itemEl.querySelector('.item-name');
      commentEl = document.createElement('span');
      commentEl.className = 'item-comment';
      commentEl.textContent = noteInput.value;
      nameEl.insertAdjacentElement('afterend', commentEl);
    }
    itemEl.querySelector('.note-btn')?.classList.add('has-note');
  } else {
    commentEl?.remove();
    itemEl.querySelector('.note-btn')?.classList.remove('has-note');
  }
});

// ════════════════════════════════════════════
// EVENTS — recipes (delegated)
// ════════════════════════════════════════════

document.getElementById('recipesRoot').addEventListener('click', e => {
  const recipeAdd = e.target.closest('[data-recipe-add]');
  if (recipeAdd) { addRecipeToList(recipeAdd.dataset.recipeAdd); return; }

  const recipeDel = e.target.closest('[data-recipe-del]');
  if (recipeDel) { deleteRecipe(recipeDel.dataset.recipeDel); return; }

  const editToggle = e.target.closest('[data-recipe-edit-toggle]');
  if (editToggle) {
    const id = editToggle.dataset.recipeEditToggle;
    const recipeEl = document.querySelector(`.recipe[data-recipe-id="${id}"]`);
    if (recipeEl) {
      const willEdit = !recipeEl.classList.contains('recipe--editing');
      if (willEdit) {
        // Ensure this card's panel is open (EDIT can be clicked from the closed-card header).
        const panel = document.getElementById(`recipe-panel-${id}`);
        if (panel && !panel.classList.contains('open')) {
          document.querySelectorAll('.recipe-panel.open').forEach(p => p.classList.remove('open'));
          closeAllRecipeAc();
          panel.classList.add('open');
        }
        document.querySelectorAll('.recipe.recipe--editing').forEach(el => {
          if (el !== recipeEl) el.classList.remove('recipe--editing');
        });
      }
      recipeEl.classList.toggle('recipe--editing', willEdit);
    }
    return;
  }

  const riToggle = e.target.closest('[data-ri-toggle]');
  if (riToggle) { riToggle.classList.toggle('active'); return; }

  const removeItem2 = e.target.closest('[data-remove-item]');
  if (removeItem2) {
    removeRecipeItem(removeItem2.dataset.recipeId, removeItem2.dataset.removeItem);
    return;
  }

  const recipeSubmit = e.target.closest('[data-recipe-submit]');
  if (recipeSubmit) { doAddRecipeItem(recipeSubmit.dataset.recipeSubmit); return; }

  const acItem = e.target.closest('.recipe-ac .ac-item');
  if (acItem) {
    const wrap = acItem.closest('.recipe-ingredient-wrap');
    const input = wrap?.querySelector('.recipe-ingredient-input');
    if (input) {
      input.value = acItem.dataset.fill;
      closeRecipeAc(input.dataset.recipeId);
      input.focus();
    }
    return;
  }

  const setType = e.target.closest('[data-recipe-set-type]');
  if (setType) {
    const id = setType.dataset.recipeId;
    const newType = setType.dataset.recipeSetType;
    const r = recipes.find(r => r.id === id);
    if (r && (r.type || 'main') !== newType) {
      r.type = newType;
      saveRecipes();
      const toggle = setType.closest('.recipe-type-toggle');
      toggle.querySelectorAll('[data-recipe-set-type]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.recipeSetType === newType);
      });
    }
    return;
  }

  const toggleEl = e.target.closest('[data-toggle-recipe]');
  if (toggleEl) { toggleRecipePanel(toggleEl.dataset.toggleRecipe); }
});

document.getElementById('recipesRoot').addEventListener('input', e => {
  const ingInput = e.target.closest('.recipe-ingredient-input');
  if (ingInput) {
    const acEl = document.getElementById(`recipe-ac-${ingInput.dataset.recipeId}`);
    if (acEl) renderAcInto(ingInput.value, acEl);
    return;
  }

  const nameInput = e.target.closest('.recipe-name-input');
  if (nameInput) {
    const id = nameInput.dataset.recipeId;
    const nameEl = document.querySelector(`.recipe[data-recipe-id="${id}"] .recipe-name-text`);
    if (nameEl) nameEl.textContent = nameInput.value || 'New Recipe';
  }
});

document.getElementById('recipesRoot').addEventListener('keydown', e => {
  const ingInput = e.target.closest('.recipe-ingredient-input');
  if (ingInput) {
    if (e.key === 'Enter') { doAddRecipeItem(ingInput.dataset.recipeId); return; }
    if (e.key === 'Escape') { closeRecipeAc(ingInput.dataset.recipeId); return; }
  }

  const amtInput = e.target.closest('.recipe-amount-input');
  if (amtInput) {
    if (e.key === 'Enter') doAddRecipeItem(amtInput.dataset.recipeId);
    return;
  }

  const nameInput = e.target.closest('.recipe-name-input');
  if (nameInput) {
    if (e.key === 'Enter' || e.key === 'Escape') {
      renameRecipe(nameInput.dataset.recipeId, nameInput.value);
      nameInput.blur();
    }
  }
});

document.getElementById('recipesRoot').addEventListener('blur', e => {
  const nameInput = e.target.closest('.recipe-name-input');
  if (nameInput) renameRecipe(nameInput.dataset.recipeId, nameInput.value);
}, true);

function doAddRecipeItem(recipeId) {
  const ingInput = document.querySelector(`.recipe-ingredient-input[data-recipe-id="${recipeId}"]`);
  const amtInput = document.querySelector(`.recipe-amount-input[data-recipe-id="${recipeId}"]`);
  if (!ingInput) return;
  const name   = ingInput.value.trim();
  const amount = amtInput ? amtInput.value.trim() : '';
  if (!name) return;
  if (addRecipeItem(recipeId, name, amount)) {
    ingInput.value = '';
    if (amtInput) amtInput.value = '';
    closeRecipeAc(recipeId);
    ingInput.focus();
  }
}

// ════════════════════════════════════════════
// AUTOCOMPLETE
// ════════════════════════════════════════════

const addInput = document.getElementById('addInput');
const zoneRow  = document.getElementById('zoneRow');
const zoneBtns = document.querySelectorAll('.zone-btn');

function buildAcHtml(matches, queryLen, storeId) {
  const names = { 0.1: 'ENT', 0.4: 'MID', 0.7: 'BCK', 0.9: 'CHK' };
  return matches.map(([key, h]) => {
    const display = h.displayName || key.replace(/\b\w/g, c => c.toUpperCase());
    const hi   = esc(display.slice(0, queryLen));
    const rest = esc(display.slice(queryLen));
    const sh   = h.stores?.[storeId];
    let badge  = '';
    if (sh && sh.hist && sh.hist.length >= 2) {
      badge = `<span class="ac-badge hist">●</span>`;
    } else if (sh && sh.zone != null) {
      badge = `<span class="ac-badge zone">${names[sh.zone] ?? '~'}</span>`;
    }
    return `<div class="ac-item" data-fill="${esc(display)}"><span><span class="ac-match">${hi}</span>${rest}</span>${badge}</div>`;
  }).join('');
}

function renderAcInto(query, acEl, storeId) {
  storeId = storeId || state.currentStoreId;
  const q = nameKey(query);
  if (!q) { acEl.classList.remove('open'); acEl.innerHTML = ''; return; }

  const matches = Object.entries(history)
    .filter(([key]) => key.startsWith(q) && key !== q)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 6);

  if (matches.length === 0) { acEl.classList.remove('open'); acEl.innerHTML = ''; return; }

  acEl.innerHTML = buildAcHtml(matches, query.length, storeId);
  acEl.classList.add('open');
  acEl.closest('.recipe-panel')?.classList.add('ac-open');
}

function renderAc(query) {
  renderAcInto(query, document.getElementById('acList'));
}

function closeAc() {
  const el = document.getElementById('acList');
  el.classList.remove('open');
}

function closeRecipeAc(recipeId) {
  const el = recipeId ? document.getElementById(`recipe-ac-${recipeId}`) : null;
  if (el) {
    el.classList.remove('open');
    el.innerHTML = '';
    el.closest('.recipe-panel')?.classList.remove('ac-open');
  }
}

function closeAllRecipeAc() {
  document.querySelectorAll('.recipe-ac.open').forEach(el => {
    el.classList.remove('open');
    el.closest('.recipe-panel')?.classList.remove('ac-open');
    el.innerHTML = '';
  });
}

document.getElementById('acList').addEventListener('click', e => {
  const item = e.target.closest('.ac-item');
  if (!item) return;
  addInput.value = item.dataset.fill;
  closeAc();
  zoneRow.classList.add('visible');
  addInput.focus();
});

document.addEventListener('pointerdown', e => {
  if (!e.target.closest('#acList') && !e.target.closest('#addInput')) closeAc();
  if (!e.target.closest('.recipe-ingredient-wrap')) closeAllRecipeAc();
});

document.getElementById('storeSwitcher').addEventListener('click', e => {
  if (e.target.closest('[data-new-recipe]')) { createRecipe(); return; }
  if (e.target.closest('[data-add-store]')) { showAddStoreForm(); return; }
  if (e.target.closest('[data-store-form-confirm]')) { confirmAddStoreFromForm(); return; }
  if (e.target.closest('[data-store-form-cancel]')) { cancelAddStoreForm(); return; }
  const typeBtn = e.target.closest('[data-store-form-type]');
  if (typeBtn) {
    addingStoreType = typeBtn.dataset.storeFormType;
    document.querySelectorAll('.store-add-type-opt').forEach(b => {
      b.classList.toggle('active', b.dataset.storeFormType === addingStoreType);
    });
    return;
  }
  const pill = e.target.closest('[data-switch-store]');
  if (pill) switchStore(pill.dataset.switchStore);
});

document.getElementById('storeSwitcher').addEventListener('keydown', e => {
  if (!e.target.closest('.store-add-name')) return;
  if (e.key === 'Enter')      { e.preventDefault(); confirmAddStoreFromForm(); }
  else if (e.key === 'Escape') { e.preventDefault(); cancelAddStoreForm(); }
});

// ════════════════════════════════════════════
// EVENTS — add form
// ════════════════════════════════════════════

addInput.addEventListener('input', () => {
  const val = addInput.value.trim();
  const hasText = val.length > 0;
  zoneRow.classList.toggle('visible', hasText);
  if (!hasText) { clearZone(); closeAc(); } else { renderAc(val); }
});

addInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeAc(); return; }
  if (e.key === 'Enter') doAdd();
});

document.getElementById('addBtn').addEventListener('click', doAdd);

function doAdd() {
  const name = addInput.value;
  if (addItem(name, pendingZone)) {
    addInput.value = '';
    clearZone();
    closeAc();
    zoneRow.classList.remove('visible');
    addInput.classList.add('success');
    setTimeout(() => addInput.classList.remove('success'), 300);
    addInput.focus();
  }
}

zoneBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const s = parseFloat(btn.dataset.score);
    if (pendingZone === s) {
      clearZone();
    } else {
      pendingZone = s;
      zoneBtns.forEach(b => b.classList.toggle('active', b === btn));
    }
  });
});

function clearZone() {
  pendingZone = null;
  zoneBtns.forEach(b => b.classList.remove('active'));
}

// ════════════════════════════════════════════
// EVENTS — view toggle
// ════════════════════════════════════════════

document.querySelectorAll('.toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.view === currentView) return;
    currentView = btn.dataset.view;
    renderView();
  });
});

// ════════════════════════════════════════════
// EVENTS — done shopping
// ════════════════════════════════════════════

document.getElementById('doneBtn').addEventListener('click', () => {
  const checkedItems = state.items
    .filter(i => i.checked)
    .sort((a, b) => {
      const ai = state.session.order.indexOf(a.id);
      const bi = state.session.order.indexOf(b.id);
      return ai - bi;
    });

  const n = checkedItems.length;
  if (n === 0) return;

  const listHtml = checkedItems.slice(0, 8).map((item, idx) => `
    <div class="dialog-item-row">
      <span class="dialog-item-num">${idx + 1}.</span>
      <span class="dialog-item-name">${esc(item.name)}</span>
    </div>`).join('') + (n > 8 ? `<div class="dialog-item-row" style="color:var(--text-dim);font-size:10px;margin-top:3px">+ ${n - 8} more</div>` : '');

  document.getElementById('dialogStats').innerHTML = `
    <strong>${n}</strong> item${n !== 1 ? 's' : ''} checked off this trip — order will be learned
    <div class="dialog-item-list">${listHtml}</div>`;

  document.getElementById('overlay').classList.add('open');
});

document.getElementById('cancelBtn').addEventListener('click', closeDialog);
document.getElementById('overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('overlay')) closeDialog();
});

document.getElementById('confirmBtn').addEventListener('click', () => {
  closeDialog();
  recordTrip();
});

function closeDialog() {
  document.getElementById('overlay').classList.remove('open');
}

// ════════════════════════════════════════════
// INDEXEDDB MIRROR (durability backup for localStorage)
// ════════════════════════════════════════════
// On iOS PWAs, localStorage can be evicted under storage pressure or after
// long periods of disuse. IndexedDB lives in a more durable bucket. localStorage
// remains the primary store (no changes to existing save paths); we mirror every
// write asynchronously, and on startup restore from IndexedDB if localStorage
// was wiped. This is belt-and-suspenders until cloud sync lands.

const IDB_NAME  = 'marketlist';
const IDB_STORE = 'kv';
let idbPromise  = null;

function idbOpen() {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve) => {
    if (!('indexedDB' in self)) { resolve(null); return; }
    let req;
    try { req = indexedDB.open(IDB_NAME, 1); }
    catch (_) { resolve(null); return; }
    req.onupgradeneeded = () => {
      try { req.result.createObjectStore(IDB_STORE); } catch (_) {}
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return idbPromise;
}

function idbGet(key) {
  return idbOpen().then(db => {
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const r  = tx.objectStore(IDB_STORE).get(key);
        r.onsuccess = () => resolve(r.result == null ? null : r.result);
        r.onerror   = () => resolve(null);
      } catch (_) { resolve(null); }
    });
  });
}

function idbSet(key, value) {
  return idbOpen().then(db => {
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        if (value == null) tx.objectStore(IDB_STORE).delete(key);
        else               tx.objectStore(IDB_STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror    = () => resolve();
        tx.onabort    = () => resolve();
      } catch (_) { resolve(); }
    });
  });
}

const TRACKED_KEYS = [STORAGE_KEY, HISTORY_KEY, RECIPES_KEY, STORES_KEY];
let idbAvailable = true;

// Wrap localStorage.setItem/removeItem to mirror tracked keys to IndexedDB.
(function installMirror() {
  const origSet    = localStorage.setItem.bind(localStorage);
  const origRemove = localStorage.removeItem.bind(localStorage);
  const tracked    = new Set(TRACKED_KEYS);

  localStorage.setItem = function (key, value) {
    try {
      origSet(key, value);
      if (tracked.has(key)) idbSet(key, value).catch(() => {});
    } catch (e) {
      const isQuota = e.name === 'QuotaExceededError' || e.code === 22;
      if (isQuota && tracked.has(key)) {
        // localStorage full — try IDB as fallback; show banner only if IDB also fails
        idbSet(key, value).catch(() => { showStorageWarningBanner(); });
      } else if (isQuota) {
        showStorageWarningBanner();
      } else {
        showToast('Save error — check your browser storage settings.');
      }
    }
  };
  localStorage.removeItem = function (key) {
    origRemove(key);
    if (tracked.has(key)) idbSet(key, null).catch(() => {});
  };
})();

async function restoreFromIdbIfNeeded() {
  for (const key of TRACKED_KEYS) {
    if (localStorage.getItem(key) == null) {
      const value = await idbGet(key);
      if (typeof value === 'string') {
        // Bypass the wrapper — we don't need to re-mirror what we just read.
        Object.getPrototypeOf(localStorage).setItem.call(localStorage, key, value);
      }
    }
  }
}

async function backfillIdbFromLocalStorage() {
  // Make sure IDB has whatever localStorage currently has, so a future
  // localStorage eviction can be recovered from.
  for (const key of TRACKED_KEYS) {
    const v = localStorage.getItem(key);
    if (v != null) idbSet(key, v).catch(() => { idbAvailable = false; });
  }
}

// ════════════════════════════════════════════
// SETTINGS / BACKUP / RESTORE
// ════════════════════════════════════════════

function exportBackup() {
  const payload = {
    app: 'market-list',
    schema: 2,
    exportedAt: new Date().toISOString(),
    data: {
      [STORAGE_KEY]:  localStorage.getItem(STORAGE_KEY),
      [HISTORY_KEY]:  localStorage.getItem(HISTORY_KEY),
      [RECIPES_KEY]:  localStorage.getItem(RECIPES_KEY),
      [STORES_KEY]:   localStorage.getItem(STORES_KEY),
    },
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  a.href = url;
  a.download = `market-list-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
  showToast('Backup downloaded');
}

function importBackupFile(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    let payload;
    try { payload = JSON.parse(String(reader.result)); }
    catch (_) { showToast('Invalid backup file'); return; }

    if (!payload || payload.app !== 'market-list' || !payload.data) {
      showToast('Not a Market List backup'); return;
    }

    const ok = await showConfirmDialog({
      title: 'Restore backup?',
      message: 'Replace your current list, history, recipes and store settings with this backup.<br>This cannot be undone.',
      confirmLabel: 'RESTORE',
      danger: true,
    });
    if (!ok) return;

    // Restore the keys that are present in this backup
    const keysToRestore = [STORAGE_KEY, HISTORY_KEY, RECIPES_KEY];
    if (payload.schema >= 2) keysToRestore.push(STORES_KEY);

    for (const key of keysToRestore) {
      const v = payload.data[key];
      if (v == null) localStorage.removeItem(key);
      else           localStorage.setItem(key, v);
    }

    // Schema 1 backup: clear storeRegistry so load() creates defaults and migrates history
    if (!payload.schema || payload.schema < 2) {
      localStorage.removeItem(STORES_KEY);
    }

    // Reset in-memory state and reload everything from storage
    history = {};
    recipes = [];
    storeRegistry = [];
    state = { items: [], currentStoreId: 'grocery_main', session: { id: uid(), storeId: 'grocery_main', order: [] }, ordered: false };
    load();
    renderView();
    showToast('Backup restored');
  };
  reader.onerror = () => showToast('Could not read file');
  reader.readAsText(file);
}

async function forceUpdate() {
  const haveSW = 'serviceWorker' in navigator;
  if (haveSW) {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg && navigator.serviceWorker.controller) {
      // Ask the SW to clear all caches; wait briefly for confirmation.
      await new Promise((resolve) => {
        const onMsg = (e) => {
          if (e.data && e.data.type === 'CACHES_CLEARED') {
            navigator.serviceWorker.removeEventListener('message', onMsg);
            resolve();
          }
        };
        navigator.serviceWorker.addEventListener('message', onMsg);
        navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_CACHES' });
        setTimeout(resolve, 1500);
      });
    }
    if (reg) await reg.unregister();
  }
  location.reload();
}

async function resetAll() {
  const ok = await showConfirmDialog({
    title: 'Reset all data?',
    message: 'Delete EVERYTHING — list, history, recipes, store settings.<br>This cannot be undone (unless you have a backup).',
    confirmLabel: 'RESET',
    danger: true,
  });
  if (!ok) return;
  history = {};
  recipes = [];
  storeRegistry = DEFAULT_STORES.map(s => ({ ...s }));
  state = { items: [], currentStoreId: 'grocery_main', session: { id: uid(), storeId: 'grocery_main', order: [] }, ordered: false };
  for (const key of TRACKED_KEYS) localStorage.removeItem(key);
  saveState(); saveHistory(); saveRecipes(); saveStores();
  renderView();
  showToast('All data reset');
}

function renderStoreListSettings() {
  const el = document.getElementById('storeListSettings');
  if (!el) return;
  el.innerHTML = storeRegistry.map(s => {
    const currentType = STORE_TYPES.some(t => t.value === s.type) ? s.type : 'other';
    const opts = STORE_TYPES.map(t =>
      `<option value="${t.value}"${t.value === currentType ? ' selected' : ''}>${esc(t.label)}</option>`
    ).join('');
    return `
    <div class="store-edit-row">
      <input class="store-name-edit" data-store-id="${esc(s.id)}"
        value="${esc(s.name)}" maxlength="30"
        autocomplete="off" spellcheck="false">
      <select class="store-type-edit" data-store-id="${esc(s.id)}" aria-label="Store type">${opts}</select>
    </div>`;
  }).join('');
}

function setStoreType(id, newType) {
  const s = storeRegistry.find(s => s.id === id);
  if (!s) return;
  if (!STORE_TYPES.some(t => t.value === newType)) return;
  if (s.type === newType) return;
  s.type = newType;
  saveStores();
  render();
}

function renameStore(id, name) {
  name = name.trim();
  if (!name) return;
  const s = storeRegistry.find(s => s.id === id);
  if (!s || s.name === name) return;
  s.name = name;
  saveStores();
  renderStoreSwitcher();
}

function addStore(name, type = 'supermarket') {
  name = name.trim();
  if (!name) return;
  if (!STORE_TYPES.some(t => t.value === type)) type = 'supermarket';
  const id = 'store_' + uid();
  storeRegistry.push({ id, name, type });
  saveStores();
  renderStoreListSettings();
  renderStoreSwitcher();
}

function showSettingsAddStoreForm() {
  const slot = document.getElementById('addStoreSlot');
  if (!slot) return;
  addingStoreType = 'supermarket';
  const typeBtns = STORE_TYPES.map(t =>
    `<button class="store-add-type-opt${t.value === addingStoreType ? ' active' : ''}" data-settings-form-type="${t.value}">${STORE_TYPE_SHORT[t.value]}</button>`
  ).join('');
  slot.innerHTML = `
    <div class="store-add-form settings-store-add-form">
      <input class="store-add-name" type="text" placeholder="Store name…" maxlength="30"
        autocomplete="off" autocorrect="off" autocapitalize="words" spellcheck="false">
      <div class="store-add-type-row">${typeBtns}</div>
      <button class="store-add-confirm" data-settings-form-confirm aria-label="Add">✓</button>
      <button class="store-add-cancel" data-settings-form-cancel aria-label="Cancel">✕</button>
    </div>`;
  const input = slot.querySelector('.store-add-name');
  if (input) input.focus();
}

function hideSettingsAddStoreForm() {
  const slot = document.getElementById('addStoreSlot');
  if (!slot) return;
  slot.innerHTML = `<button class="settings-btn" id="addStoreBtn">+ Add store</button>`;
}

function confirmSettingsAddStoreForm() {
  const slot = document.getElementById('addStoreSlot');
  if (!slot) return;
  const input = slot.querySelector('.store-add-name');
  if (!input) return;
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  addStore(name, addingStoreType);
  hideSettingsAddStoreForm();
}

// Generic confirmation dialog backed by #confirmOverlay. Returns Promise<boolean>.
function showConfirmDialog({ title, message, confirmLabel = 'CONFIRM', cancelLabel = 'Cancel', danger = false }) {
  return new Promise(resolve => {
    const overlay    = document.getElementById('confirmOverlay');
    const titleEl    = document.getElementById('confirmDialogTitle');
    const messageEl  = document.getElementById('confirmDialogMessage');
    const confirmBtn = document.getElementById('confirmDialogConfirm');
    const cancelBtn  = document.getElementById('confirmDialogCancel');

    titleEl.textContent   = title;
    messageEl.innerHTML   = message;
    confirmBtn.textContent = confirmLabel;
    cancelBtn.textContent  = cancelLabel;
    confirmBtn.classList.toggle('btn-danger', !!danger);

    const close = (val) => {
      overlay.classList.remove('open');
      confirmBtn.removeEventListener('click', onYes);
      cancelBtn.removeEventListener('click', onNo);
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onYes      = () => close(true);
    const onNo       = () => close(false);
    const onBackdrop = (e) => { if (e.target === overlay) close(false); };
    const onKey      = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      else if (e.key === 'Enter') { e.preventDefault(); close(true); }
    };

    confirmBtn.addEventListener('click', onYes);
    cancelBtn.addEventListener('click', onNo);
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);

    overlay.classList.add('open');
  });
}

function openSettings() {
  const versionLabel = document.getElementById('appVersionLabel');
  versionLabel.textContent = '—';
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    const onMsg = (e) => {
      if (e.data && e.data.type === 'VERSION') {
        versionLabel.textContent = e.data.version;
        navigator.serviceWorker.removeEventListener('message', onMsg);
      }
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    navigator.serviceWorker.controller.postMessage({ type: 'GET_VERSION' });
  }
  document.getElementById('storageStatusLabel').textContent =
    idbAvailable ? 'localStorage + IDB' : 'localStorage only';
  renderStoreListSettings();
  hideSettingsAddStoreForm();
  document.getElementById('settingsOverlay').classList.add('open');
}
function closeSettings() {
  document.getElementById('settingsOverlay').classList.remove('open');
}

document.getElementById('settingsBtn').addEventListener('click', openSettings);
document.getElementById('settingsCloseBtn').addEventListener('click', closeSettings);
document.getElementById('settingsOverlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('settingsOverlay')) closeSettings();
});

document.getElementById('exportBtn').addEventListener('click', exportBackup);
document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importInput').click();
});
document.getElementById('importInput').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) importBackupFile(file);
  e.target.value = ''; // allow same-file re-pick
});
document.getElementById('forceUpdateBtn').addEventListener('click', forceUpdate);
document.getElementById('resetAllBtn').addEventListener('click', () => {
  closeSettings();
  resetAll();
});

document.getElementById('addStoreSlot').addEventListener('click', e => {
  if (e.target.closest('#addStoreBtn')) { showSettingsAddStoreForm(); return; }
  if (e.target.closest('[data-settings-form-confirm]')) { confirmSettingsAddStoreForm(); return; }
  if (e.target.closest('[data-settings-form-cancel]'))  { hideSettingsAddStoreForm(); return; }
  const typeBtn = e.target.closest('[data-settings-form-type]');
  if (typeBtn) {
    addingStoreType = typeBtn.dataset.settingsFormType;
    document.querySelectorAll('#addStoreSlot .store-add-type-opt').forEach(b => {
      b.classList.toggle('active', b.dataset.settingsFormType === addingStoreType);
    });
  }
});

document.getElementById('addStoreSlot').addEventListener('keydown', e => {
  if (!e.target.closest('.store-add-name')) return;
  if (e.key === 'Enter')       { e.preventDefault(); confirmSettingsAddStoreForm(); }
  else if (e.key === 'Escape') { e.preventDefault(); hideSettingsAddStoreForm(); }
});

document.getElementById('storeListSettings').addEventListener('blur', e => {
  const input = e.target.closest('.store-name-edit');
  if (input) renameStore(input.dataset.storeId, input.value);
}, true);

document.getElementById('storeListSettings').addEventListener('change', e => {
  const sel = e.target.closest('.store-type-edit');
  if (sel) setStoreType(sel.dataset.storeId, sel.value);
});

document.getElementById('storeListSettings').addEventListener('keydown', e => {
  const input = e.target.closest('.store-name-edit');
  if (!input) return;
  if (e.key === 'Enter' || e.key === 'Escape') {
    renameStore(input.dataset.storeId, input.value);
    input.blur();
  }
});

// ════════════════════════════════════════════
// SERVICE WORKER REGISTRATION
// ════════════════════════════════════════════

if ('serviceWorker' in navigator) {
  // Register after load so we don't compete with first-paint.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      let reloading = false;
      const reloadOnce = () => {
        if (reloading) return;
        reloading = true;
        location.reload();
      };

      // Startup check: a worker is already waiting from a previous session.
      // Activate it silently before the user touches anything.
      if (reg.waiting && navigator.serviceWorker.controller) {
        navigator.serviceWorker.addEventListener('controllerchange', reloadOnce);
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        return;
      }

      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state !== 'installed') return;
          // No existing controller => first install, nothing to update.
          if (!navigator.serviceWorker.controller) return;
          showUpdateBanner(reg, reloadOnce);
        });
      });
    }).catch((err) => {
      console.warn('[app] service worker registration failed:', err);
    });
  });
}

function showUpdateBanner(reg, reloadOnce) {
  if (document.getElementById('sw-update-banner')) return;

  const banner = document.createElement('div');
  banner.id = 'sw-update-banner';
  Object.assign(banner.style, {
    position: 'fixed',
    left: '12px',
    right: '12px',
    bottom: '12px',
    zIndex: '300',
    background: 'var(--surface, #1a1a1a)',
    color: 'var(--text, #f0ebe0)',
    border: '1px solid var(--accent-border, rgba(232,160,32,0.3))',
    borderRadius: 'var(--radius, 5px)',
    boxShadow: '0 4px 18px rgba(0,0,0,0.55)',
    padding: '12px 14px',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    fontFamily: "'Space Mono', ui-monospace, 'SF Mono', Menlo, Monaco, Consolas, monospace",
    fontSize: '12px',
    lineHeight: '1.4',
  });

  const msg = document.createElement('span');
  msg.textContent = 'An update is available';
  msg.style.flex = '1';

  const updateBtn = document.createElement('button');
  updateBtn.type = 'button';
  updateBtn.textContent = 'Update now';
  Object.assign(updateBtn.style, {
    background: 'var(--accent, #e8a020)',
    color: '#000',
    border: 'none',
    borderRadius: 'var(--radius, 5px)',
    fontFamily: "'Oswald', Impact, 'Helvetica Neue Condensed', 'Arial Narrow', sans-serif",
    fontSize: '13px',
    fontWeight: '700',
    letterSpacing: '0.06em',
    padding: '8px 12px',
    cursor: 'pointer',
  });

  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.setAttribute('aria-label', 'Dismiss update notice');
  dismissBtn.textContent = '×';
  Object.assign(dismissBtn.style, {
    background: 'transparent',
    color: 'var(--text-muted, #777)',
    border: '1px solid var(--border, #2e2e2e)',
    borderRadius: 'var(--radius, 5px)',
    fontFamily: 'inherit',
    fontSize: '14px',
    lineHeight: '1',
    width: '28px',
    height: '28px',
    cursor: 'pointer',
  });

  updateBtn.addEventListener('click', () => {
    updateBtn.disabled = true;
    updateBtn.textContent = 'Updating...';
    navigator.serviceWorker.addEventListener('controllerchange', reloadOnce);
    // Read reg.waiting at click time — a fresh worker may have arrived since the banner showed.
    const waiting = reg.waiting;
    if (waiting) {
      waiting.postMessage({ type: 'SKIP_WAITING' });
    } else {
      // No waiting worker right now — controllerchange will still fire when one activates.
    }
  });

  dismissBtn.addEventListener('click', () => {
    banner.remove();
  });

  banner.appendChild(msg);
  banner.appendChild(updateBtn);
  banner.appendChild(dismissBtn);
  document.body.appendChild(banner);
}

// ════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════

(async function init() {
  try { await restoreFromIdbIfNeeded(); } catch (_) {}
  load();
  // Make sure IDB mirror has whatever localStorage currently has.
  backfillIdbFromLocalStorage().catch(() => {});
  renderView();
})();
