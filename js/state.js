// Shared state, persistence, and IndexedDB mirror.
//
// Cross-module mutable values are exported either as `let` bindings (the four
// big collections; replaceable via setters) or grouped onto `ui` (UI state;
// mutated directly via `ui.x = ...`). All persistence flows through setState()
// — saveState/saveHistory/saveStores/saveRecipes are called only here and from
// inside setState().
//
// Render & save-error hooks are injected from app.js (setRenderHooks) so this
// module does not import from render.js — the DAG is uid → state → scoring →
// render → events → app.js.

import { uid } from './uid.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_STORES = [
  { id: 'grocery_main', name: 'Supermarkt', type: 'supermarket' },
  { id: 'dm_main',      name: 'DM',         type: 'drugstore' }
];

export const STORE_TYPES = [
  { value: 'supermarket', label: 'Supermarket' },
  { value: 'drugstore',   label: 'Drugstore' },
  { value: 'pharmacy',    label: 'Pharmacy' },
  { value: 'other',       label: 'Other' },
];

export const STORE_TYPE_SHORT = {
  supermarket: 'SUPER',
  drugstore:   'DRUG',
  pharmacy:    'PHARM',
  other:       'OTHER',
};

export const STORAGE_KEY          = 'marketlist_v2';
export const HISTORY_KEY          = 'itemHistory';
export const RECIPES_KEY          = 'recipes';
export const STORES_KEY           = 'storeRegistry';
export const SHOW_SORT_BADGES_KEY = 'showSortBadges';
export const TRACKED_KEYS = [STORAGE_KEY, HISTORY_KEY, RECIPES_KEY, STORES_KEY];

// ─── Mutable state ────────────────────────────────────────────────────────────

export let state = {
  items: [],
  currentStoreId: 'grocery_main',
  session: { id: uid(), storeId: 'grocery_main', order: [] },
  ordered: false
};

export let history = {};
export let recipes = [];
export let storeRegistry = [];

export function replaceState(s)         { state = s; }
export function replaceHistory(h)       { history = h; }
export function replaceRecipes(r)       { recipes = r; }
export function replaceStoreRegistry(s) { storeRegistry = s; }

// UI state — grouped so consumers can `ui.x = ...` without setters.
export const ui = {
  currentView: 'list',
  reorderMode: false,
  showSortBadges: localStorage.getItem(SHOW_SORT_BADGES_KEY) === 'true',
  unknownSectionOpen: false,
  pendingZone: null,
  addingStoreType: 'supermarket',
  // Most recently added item id — consumed once by the next render() to stamp
  // data-new="true" for the highlightFade animation, then cleared.
  lastAddedId: null,
  // Only one item can be in rename mode at a time. null when no rename active.
  currentRenameItemId: null,
};

// IDs of items waiting on the undo window. render() reapplies the
// .item--pending-delete class to these rows so unrelated re-renders
// (add item, toggle, switch store) don't visually unhide a row that's
// still in soft-delete limbo.
export const pendingDeleteIds = new Set();

export let idbAvailable = true;
export function setIdbAvailable(v) { idbAvailable = v; }

// ─── Hook injection (wired up by app.js at startup) ───────────────────────────

let _renderList    = () => {};
let _renderRecipes = () => {};
let _onQuotaWarn   = () => {};
let _onSaveError   = () => {};
let _sortItems     = (items /* , storeId */) => items; // identity until wired

export function setRenderHooks({ renderList, renderRecipes, onQuotaWarn, onSaveError } = {}) {
  if (renderList)    _renderList    = renderList;
  if (renderRecipes) _renderRecipes = renderRecipes;
  if (onQuotaWarn)   _onQuotaWarn   = onQuotaWarn;
  if (onSaveError)   _onSaveError   = onSaveError;
}

export function setSortFn(fn) { _sortItems = fn; }

// ─── Persistence ──────────────────────────────────────────────────────────────

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

export function load() {
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
          const key = nameKeyLocal(item.name);
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

  // One-time migration: sort existing items by score so the stored order is meaningful.
  // sorted() is injected from scoring.js to keep the DAG acyclic.
  if (!state.ordered) {
    state.items = _sortItems(state.items, state.currentStoreId);
    state.ordered = true;
    saveState();
  }
}

// Local copy of nameKey to avoid an import cycle if uid.js ever grew deps.
// (Currently identical to ./uid.js's nameKey.)
function nameKeyLocal(name) {
  return name.toLowerCase().trim();
}

export function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    items: state.items,
    currentStoreId: state.currentStoreId,
    session: state.session,
    ordered: state.ordered
  }));
}

export function saveHistory() {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

export function saveStores() {
  localStorage.setItem(STORES_KEY, JSON.stringify(storeRegistry));
}

export function saveRecipes() {
  localStorage.setItem(RECIPES_KEY, JSON.stringify(recipes));
}

// setState() is the single dispatch path for persisting and re-rendering after
// any change to state.items / history / recipes / storeRegistry. Callers mutate
// the relevant in-memory structure (directly or via `updates`), then call this
// to merge, persist, and render in one step.
//
// updates: partial of { items, currentStoreId, session, ordered }
// options:
//   historyChanged — also save history
//   recipesChanged — also save recipes
//   storesChanged  — also save storeRegistry
//   skipRender     — caller will handle rendering itself (e.g. multi-step ops
//                    that need to call renderStoreSwitcher / renderView / a
//                    targeted partial render before or instead of render())
export function setState(updates, options = {}) {
  if (updates) Object.assign(state, updates);
  saveState();
  if (options.historyChanged) saveHistory();
  if (options.recipesChanged) saveRecipes();
  if (options.storesChanged)  saveStores();
  if (!options.skipRender) {
    if (ui.currentView === 'recipes') _renderRecipes();
    else                              _renderList();
  }
}

// ─── IndexedDB mirror (durability backup for localStorage) ────────────────────
// On iOS PWAs, localStorage can be evicted under storage pressure or after
// long periods of disuse. IndexedDB lives in a more durable bucket. localStorage
// remains the primary store (no changes to existing save paths); we mirror every
// write asynchronously, and on startup restore from IndexedDB if localStorage
// was wiped. This is belt-and-suspenders until cloud sync lands.

const IDB_NAME  = 'marketlist';
const IDB_STORE = 'kv';
let idbPromise  = null;

export function idbOpen() {
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

export function idbGet(key) {
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

export function idbSet(key, value) {
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

// Wrap localStorage.setItem/removeItem to mirror tracked keys to IndexedDB.
// Called once at app startup (after hooks are wired) by app.js.
export function installMirror() {
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
        idbSet(key, value).catch(() => { _onQuotaWarn(); });
      } else if (isQuota) {
        _onQuotaWarn();
      } else {
        _onSaveError();
      }
    }
  };
  localStorage.removeItem = function (key) {
    origRemove(key);
    if (tracked.has(key)) idbSet(key, null).catch(() => {});
  };
}

export async function restoreFromIdbIfNeeded() {
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

export async function backfillIdbFromLocalStorage() {
  // Make sure IDB has whatever localStorage currently has, so a future
  // localStorage eviction can be recovered from.
  for (const key of TRACKED_KEYS) {
    const v = localStorage.getItem(key);
    if (v != null) idbSet(key, v).catch(() => { idbAvailable = false; });
  }
}
