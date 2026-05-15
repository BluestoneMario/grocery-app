# Multi-Store Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the single-store grocery PWA to support multiple stores, with per-store learned sort order, availability inference, store switching, and a basic store management UI.

**Architecture:** All logic lives in one file (`index.html`, ~2726 lines). New data model: `storeRegistry` (new `localStorage` key) stores store definitions; `history[nameKey].stores[storeId]` replaces the flat `zone`/`hist` shape; `state.currentStoreId` tracks the active store; `state.session.storeId` locks the store for a trip. A one-time migration in `load()` detects old flat history entries and restructures them.

**Tech Stack:** Vanilla JS, localStorage + IndexedDB mirror, no build system, no test framework. Verify each task by opening `index.html` in a browser (or LiveServer). All changes go to the single `index.html` file.

---

## File Map

All changes are in one file:

- **Modify:** `Grocery App/index.html`

Sections (by current line range, for navigation):
- `STATE` block: lines ~1383–1411
- `PERSISTENCE` block: lines ~1413–1477
- `SCORING` block: lines ~1479–1511
- `ACTIONS — list` block: lines ~1513–1628
- `RENDER — list` block: lines ~1724–1870
- `AUTOCOMPLETE` block: lines ~2300–2368
- `EVENTS — add form` block: lines ~2370–2414
- `INDEXEDDB MIRROR` block: lines ~2471–2569
- `SETTINGS / BACKUP / RESTORE` block: lines ~2571–2697
- `INIT` block: lines ~2713–2722
- HTML `<header>` block: lines ~1264–1323
- HTML settings dialog: lines ~1351–1381
- CSS `<style>` block: lines ~28–1262

---

## Task 1 — Data Model Scaffolding (constants, state, storeRegistry, persistence)

**Files:**
- Modify: `index.html` — STATE, PERSISTENCE, IDB MIRROR sections

### Goal
Add the new constants and variables; update `saveState()` / `saveHistory()`; add `saveStores()`; wire `storeRegistry` into the IDB mirror.

- [ ] **Step 1: Add new constants and state variables**

Find the `STATE` block (search for `// ════ STATE`). Replace the entire STATE block:

```js
// ════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════

const DEFAULT_STORES = [
  { id: 'grocery_main', name: 'Supermarkt', type: 'grocery' },
  { id: 'dm_main',      name: 'DM',         type: 'drugstore' }
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
```

- [ ] **Step 2: Add STORES_KEY constant and update persistence constants**

Find the `PERSISTENCE` block (search for `const STORAGE_KEY`). Replace the three constant lines:

```js
const STORAGE_KEY  = 'marketlist_v2';
const HISTORY_KEY  = 'itemHistory';
const RECIPES_KEY  = 'recipes';
const STORES_KEY   = 'storeRegistry';
```

- [ ] **Step 3: Add `saveStores()` and update `saveState()`**

Find `saveState()`. Replace it and add `saveStores()` after `saveHistory()`:

```js
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
```

- [ ] **Step 4: Wire `STORES_KEY` into the IDB mirror**

Find `const TRACKED_KEYS = [STORAGE_KEY, HISTORY_KEY, RECIPES_KEY];` and update it:

```js
const TRACKED_KEYS = [STORAGE_KEY, HISTORY_KEY, RECIPES_KEY, STORES_KEY];
```

- [ ] **Step 5: Verify the file saves without JS errors**

Open `index.html` in a browser. Open DevTools console. There should be no errors. The app should behave exactly as before (stores aren't wired in yet).

---

## Task 2 — Migration in `load()`

**Files:**
- Modify: `index.html` — PERSISTENCE `load()` function

### Goal
Detect the old flat history shape and restructure it; load `storeRegistry` (creating defaults if absent); populate `state.currentStoreId` and `state.session.storeId` from persisted values.

- [ ] **Step 1: Add the migration helper function**

Add this function immediately before the `load()` function:

```js
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
    if ('zone' in h || 'hist' in h) {
      const zone = h.zone ?? null;
      const hist = h.hist || [];
      history[key] = {
        displayName: h.displayName || null,
        comments: h.comments || [],
        stores: { grocery_main: { zone, hist } },
        notAt: []
      };
    } else {
      if (!h.stores)  h.stores  = {};
      if (!h.notAt)   h.notAt   = [];
      if (!h.comments) h.comments = [];
    }
  }
  return true;
}
```

- [ ] **Step 2: Replace the entire `load()` function**

Find and replace the whole `load()` function (search for `function load() {`):

```js
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
            history[key] = { zone: item.zone ?? null, hist: item.hist || [] };
            migrated = true;
          }
          return { id: item.id, name: item.name, checked: !!item.checked, comment: item.comment || '' };
        }
        return { id: item.id, name: item.name, checked: !!item.checked, comment: item.comment || '' };
      });
      if (migrated) saveHistory();
      state.currentStoreId = parsed.currentStoreId || 'grocery_main';
      state.session = parsed.session || { id: uid(), storeId: state.currentStoreId, order: [] };
      if (!state.session.storeId) state.session.storeId = 'grocery_main';
      state.ordered = parsed.ordered || false;
    }
  } catch (_) {}

  // Migrate history from old flat shape to store-scoped shape
  if (migrateHistoryIfNeeded()) saveHistory();

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
  }

  // One-time migration: sort existing items by score so the stored order is meaningful
  if (!state.ordered) {
    state.items = sorted(state.items, state.currentStoreId);
    state.ordered = true;
    saveState();
  }
}
```

- [ ] **Step 3: Update `resetAll()` to reset storeRegistry**

Find `function resetAll()` and replace its body:

```js
function resetAll() {
  const ok = confirm('Delete EVERYTHING — list, history, recipes, store settings? This cannot be undone (unless you have a backup).');
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
```

- [ ] **Step 4: Update `importBackupFile()` in-memory state reset**

Find the line inside `importBackupFile()` that resets state:
```js
state = { items: [], session: { id: uid(), order: [] }, ordered: false };
```
Replace it with:
```js
storeRegistry = [];
state = { items: [], currentStoreId: 'grocery_main', session: { id: uid(), storeId: 'grocery_main', order: [] }, ordered: false };
```

- [ ] **Step 5: Verify migration in browser**

1. Open DevTools → Application → Local Storage.
2. Manually set `itemHistory` to: `{"milk":{"zone":0.1,"hist":[{"sid":"abc","pos":0.25}],"displayName":"Milk","comments":["2L"]}}`
3. Reload the page.
4. Check `itemHistory` in localStorage — should now contain `{"milk":{"displayName":"Milk","comments":["2L"],"stores":{"grocery_main":{"zone":0.1,"hist":[{"sid":"abc","pos":0.25}]}},"notAt":[]}}`.
5. Check `storeRegistry` appears with the two default stores.

---

## Task 3 — Store-Scoped Scoring Functions

**Files:**
- Modify: `index.html` — SCORING block

### Goal
Update `score()`, `indicator()`, `sorted()`, and `insertItem()` to use the new history shape and accept a `storeId` parameter.

- [ ] **Step 1: Replace the entire SCORING block**

Find `// ════ SCORING` and replace the whole block (score, indicator, sorted, insertItem):

```js
// ════════════════════════════════════════════
// SCORING
// ════════════════════════════════════════════
// Note: sorted() is used only for the one-time migration sort in load().
// render() uses state.items order directly from this point on.

function score(item, storeId) {
  const h = history[nameKey(item.name)];
  const sh = h?.stores?.[storeId];
  if (sh && sh.hist && sh.hist.length >= 2) {
    return sh.hist.reduce((s, e) => s + e.pos, 0) / sh.hist.length;
  }
  if (sh && sh.zone != null) return sh.zone;
  return 1.0;
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
  return { cls: 'none', label: '—', tip: 'no data' };
}

function sorted(items, storeId) {
  return [...items].sort((a, b) => {
    if (a.checked !== b.checked) return a.checked ? 1 : -1;
    return score(a, storeId) - score(b, storeId);
  });
}

function getAvailability(item, storeId) {
  const h = history[nameKey(item.name)];
  if (h && h.notAt && h.notAt.includes(storeId)) return 'unavailable';
  if (h && h.stores && h.stores[storeId]) return 'known';
  return 'unknown';
}
```

- [ ] **Step 2: Update `insertItem()` in the ACTIONS block**

Find `function insertItem(item)` and replace it:

```js
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
```

- [ ] **Step 3: Verify no JS errors in console, app still renders**

Reload the page. No console errors. The list still shows items normally.

---

## Task 4 — Store-Scoped addItem() and Zone Picker

**Files:**
- Modify: `index.html` — ACTIONS `addItem()` function

### Goal
`addItem()` must write zones and displayName into the new `history[key].stores[storeId]` shape. Existing zone button event handler already calls `addItem(name, pendingZone)` — no change needed there, just fix the inner logic.

- [ ] **Step 1: Replace `addItem()`**

Find `function addItem(name, zone)` and replace it:

```js
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

  if (zone != null) {
    if (!history[key].stores[storeId]) {
      history[key].stores[storeId] = { zone: null, hist: [] };
    }
    if (history[key].stores[storeId].zone == null) {
      history[key].stores[storeId].zone = zone;
      histChanged = true;
    }
  }

  if (histChanged) saveHistory();

  insertItem({ id: uid(), name, checked: false, comment: '' });
  if (!state.ordered) state.ordered = true;
  saveState();
  render();
  return true;
}
```

- [ ] **Step 2: Verify zone picker writes to correct store**

1. Open app. Make sure Supermarkt is the active store.
2. Type an item name (e.g., "shampoo"). Select a zone (e.g., MID). Press ADD.
3. Open DevTools → localStorage → `itemHistory`.
4. Verify: `{"shampoo":{"displayName":"shampoo","comments":[],"stores":{"grocery_main":{"zone":0.4,"hist":[]}},"notAt":[]}}`.

---

## Task 5 — Store-Scoped `recordTrip()`

**Files:**
- Modify: `index.html` — ACTIONS `recordTrip()` function

### Goal
`recordTrip()` must use `state.session.storeId` (not `state.currentStoreId`) to lock trip positions to the store the session started on, and write into `history[key].stores[sessionStoreId]`.

- [ ] **Step 1: Replace `recordTrip()`**

Find `function recordTrip()` and replace it:

```js
function recordTrip() {
  const sessionStoreId = state.session.storeId || 'grocery_main';
  const order = state.session.order;
  const n = order.length;
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
        if (!history[key].stores)  history[key].stores  = {};
        if (!history[key].comments) history[key].comments = [];
        if (!history[key].notAt)   history[key].notAt   = [];
        if (!history[key].displayName) history[key].displayName = item.name;
      }
      if (!history[key].stores[sessionStoreId]) {
        history[key].stores[sessionStoreId] = { zone: null, hist: [] };
      }
      history[key].stores[sessionStoreId].hist.push({ sid, pos: (idx + 1) / n });
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

  state.items   = [];
  state.session = { id: uid(), storeId: state.currentStoreId, order: [] };
  saveState();
  render();
  showToast(n > 0 ? `Trip recorded — ${n} item${n !== 1 ? 's' : ''} learned` : 'List reset');
}
```

- [ ] **Step 2: Verify trip recording in browser**

1. Add two items: "milk" and "eggs". Check them both off in order. Press "DONE SHOPPING" → "RECORD & RESET".
2. Open localStorage → `itemHistory`. Both items should have `stores.grocery_main.hist` with position entries.

---

## Task 6 — Store Switcher UI + render() Availability Buckets

**Files:**
- Modify: `index.html` — CSS, HTML `<header>`, RENDER `render()` and `itemHtml()`

### Goal
Add store switcher pills to the header. Update `render()` to partition unchecked items into known / unknown / unavailable buckets. Render unknown items in a collapsible `<details>` section. Pass `storeId` to `indicator()`.

- [ ] **Step 1: Add CSS for store switcher and unknown section**

Find the end of the `<style>` block (look for `.settings-close:active {`). Add these styles just before the closing `</style>` tag:

```css
/* ── STORE SWITCHER ── */
.store-switcher {
  display: flex;
  gap: 5px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.store-pill {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  color: var(--text-muted);
  font-family: 'Oswald', Impact, 'Helvetica Neue Condensed', 'Arial Narrow', sans-serif;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.07em;
  padding: 5px 13px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
  user-select: none;
  white-space: nowrap;
}

.store-pill.active {
  background: var(--accent-dim);
  border-color: var(--accent-border);
  color: var(--accent);
}

.store-pill:active { opacity: 0.8; }

/* ── UNKNOWN AVAILABILITY SECTION ── */
.unknown-section {
  border-top: 1px solid var(--border-light);
}

.unknown-section summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px 4px;
  list-style: none;
  cursor: pointer;
  user-select: none;
}

.unknown-section summary::-webkit-details-marker { display: none; }

.unknown-toggle-icon {
  font-size: 9px;
  color: var(--text-dim);
  transition: transform 0.18s;
  margin-left: auto;
  flex-shrink: 0;
}

.unknown-section[open] .unknown-toggle-icon {
  transform: rotate(180deg);
}

/* ── NOTE PANEL: expand height for availability button ── */
.item-note-panel.open {
  max-height: 200px;  /* was 140px; avail button adds ~45px */
}

/* ── AVAILABILITY TOGGLE BUTTON (in note panel) ── */
.avail-btn {
  display: block;
  width: 100%;
  margin-top: 7px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text-muted);
  font-family: 'Space Mono', ui-monospace, 'SF Mono', Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  padding: 7px 10px;
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s, color 0.15s;
}

.avail-btn:active {
  border-color: var(--accent-border);
  color: var(--accent);
}

.avail-btn.is-unavailable {
  color: var(--red);
  border-color: rgba(224,85,85,0.3);
}

/* ── STORE NAME INPUT (settings) ── */
.store-edit-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 5px;
}

.store-name-edit {
  flex: 1;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  font-family: 'Space Mono', ui-monospace, 'SF Mono', Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  padding: 7px 10px;
  outline: none;
  transition: border-color 0.2s;
}

.store-name-edit:focus { border-color: var(--accent-border); }
```

- [ ] **Step 2: Add store switcher HTML to the header**

Find the header HTML block. After the closing `</div>` of `.view-toggle` (line ~1288) and before `<div class="add-row"`, add:

```html
  <div class="store-switcher" id="storeSwitcher"></div>
```

The header structure should now be:
```
<div class="header-row">...</div>
<div class="view-toggle">...</div>
<div class="store-switcher" id="storeSwitcher"></div>   ← NEW
<div class="add-row" id="addRow">...</div>
<div class="zone-row" id="zoneRow">...</div>
```

- [ ] **Step 3: Add `renderStoreSwitcher()` and `switchStore()` functions**

Add these functions just before the `render()` function:

```js
function renderStoreSwitcher() {
  const el = document.getElementById('storeSwitcher');
  if (!el) return;
  el.innerHTML = storeRegistry.map(s =>
    `<button class="store-pill${s.id === state.currentStoreId ? ' active' : ''}" data-switch-store="${esc(s.id)}">${esc(s.name)}</button>`
  ).join('');
}

function switchStore(id) {
  if (id === state.currentStoreId) return;
  state.currentStoreId = id;
  saveState();
  renderStoreSwitcher();
  render();
}
```

- [ ] **Step 4: Add store-switcher click delegation**

Find the pointerdown event that closes autocomplete (search for `document.addEventListener('pointerdown', e =>`). After that block, add:

```js
document.getElementById('storeSwitcher').addEventListener('click', e => {
  const pill = e.target.closest('[data-switch-store]');
  if (pill) switchStore(pill.dataset.switchStore);
});
```

- [ ] **Step 5: Update `itemHtml()` to pass `storeId` to `indicator()`**

Find `function itemHtml(item)`. At the top of the function, find:
```js
const ind = indicator(item);
```
Replace with:
```js
const ind = indicator(item, state.currentStoreId);
```

Also update the note panel section to include the availability toggle button. Find the note panel HTML inside `itemHtml()`:

```js
  return `
    <div class="${cls}" data-id="${item.id}">
      <div class="item-main">
```

Inside the `<div class="item-note-panel">` block (near the end of the template literal), add the availability button after the `<input class="note-input"...>` element:

```js
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
```

Replace the opening lines of `itemHtml()` with the block below. It replaces the existing `const ind = indicator(item)` and `const h = ...` declarations — do not add these as duplicates:

```js
function itemHtml(item) {
  const storeId   = state.currentStoreId;
  const store     = storeRegistry.find(s => s.id === storeId);
  const storeName = store ? store.name : storeId;
  const ind       = indicator(item, storeId);
  const inReorder = reorderMode && !item.checked;
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
    <button class="avail-btn${isUnavail ? ' is-unavailable' : ''}"
      data-avail-toggle="${item.id}"
    >${isUnavail ? `Mark as available at ${esc(storeName)}` : `Not sold at ${esc(storeName)}`}</button>`;
```

Then continue with the rest of the function unchanged (commentText, noteBtnCls, chipsHtml, dragHandleHtml, and the template literal return), adding `${availBtnHtml}` at the end of the note panel div as shown above.

- [ ] **Step 6: Wire the avail-toggle click in the list delegated handler**

Find the `listRoot` click handler (search for `document.getElementById('listRoot').addEventListener('click'`). Add a new case at the top of the handler (before the noteBtn check):

```js
  const availBtn = e.target.closest('[data-avail-toggle]');
  if (availBtn) { toggleAvailability(availBtn.dataset.availToggle, state.currentStoreId); return; }
```

- [ ] **Step 7: Add `toggleAvailability()` function**

Add this function near the other action functions (e.g., after `removeItem()`):

```js
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
```

- [ ] **Step 8: Replace `render()` with the bucketed version**

Find `function render()` and replace the entire function:

```js
function render() {
  const storeId = state.currentStoreId;
  const all     = state.items;
  const checked = all.filter(i => i.checked);

  const unchecked = all.filter(i => !i.checked);
  const knownItems   = unchecked.filter(i => getAvailability(i, storeId) === 'known');
  const unknownItems = unchecked.filter(i => getAvailability(i, storeId) === 'unknown');
  // unavailable items are not rendered

  const total = all.length;
  const visibleUnchecked = knownItems.length + unknownItems.length;

  // Reorder button: show when ≥2 known items; unknown items are excluded from drag-reorder
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

  // Known items section
  if (knownItems.length > 0) {
    html += `<div class="list-section">`;
    if (checked.length > 0 || unknownItems.length > 0) {
      html += `
        <div class="section-header">
          <span class="section-label">to get</span>
          <span class="section-count">${knownItems.length}</span>
          <span class="section-line"></span>
        </div>`;
    }
    html += knownItems.map(itemHtml).join('');
    html += `</div>`;
  }

  // Unknown availability collapsible section
  if (unknownItems.length > 0) {
    html += `
      <details class="unknown-section" ${unknownSectionOpen ? 'open' : ''}>
        <summary>
          <span class="section-label">Unknown availability</span>
          <span class="section-count">${unknownItems.length}</span>
          <span class="section-line"></span>
          <span class="unknown-toggle-icon">▾</span>
        </summary>
        ${unknownItems.map(itemHtml).join('')}
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
    html += checked.map(itemHtml).join('');
    html += `</div>`;
  }

  root.innerHTML = html;

  // Persist unknown section open/closed state across re-renders
  const detailsEl = root.querySelector('.unknown-section');
  if (detailsEl) {
    detailsEl.addEventListener('toggle', () => {
      unknownSectionOpen = detailsEl.open;
    }, { once: false });
  }
}
```

- [ ] **Step 9: Call `renderStoreSwitcher()` from `renderView()`**

Find `function renderView()`. Inside the `if (currentView === 'list')` branch, after the `render();` call, add:

```js
    renderStoreSwitcher();
```

Also add it to the `else` branch (recipes view) so it stays visible when switching tabs — add before `renderRecipes()`:
```js
    renderStoreSwitcher();
```

- [ ] **Step 10: Verify in browser**

1. Reload. Two store pills appear: "Supermarkt" and "DM".
2. "Supermarkt" is highlighted (active).
3. Items with no grocery_main history appear in the collapsed "Unknown availability" section.
4. Click "DM" — list re-renders; all items move to "Unknown availability" (no DM history yet).
5. Click an item's pencil icon — note panel opens, showing "Not sold at DM" button.
6. Tap "Not sold at DM" — item disappears. Switch to Supermarkt — item reappears.

---

## Task 7 — Store Management UI in Settings

**Files:**
- Modify: `index.html` — settings dialog HTML, settings JS

### Goal
Add a Stores section to the settings dialog. Users can rename stores and add new ones.

- [ ] **Step 1: Add the Stores section HTML to the settings dialog**

Find the settings dialog HTML (search for `<div class="overlay" id="settingsOverlay">`). Insert a new `settings-section` div after the first section (after the closing `</div>` of the app version/storage section):

```html
    <div class="settings-section" id="storesMgmtSection">
      <div class="settings-section-title">Stores</div>
      <div id="storeListSettings"></div>
      <button class="settings-btn" id="addStoreBtn">+ Add store</button>
    </div>
```

Place it between the first section (app info) and the Backup section.

- [ ] **Step 2: Add `renderStoreListSettings()` function**

Add this function near the settings functions (e.g., after `closeSettings()`):

```js
function renderStoreListSettings() {
  const el = document.getElementById('storeListSettings');
  if (!el) return;
  el.innerHTML = storeRegistry.map(s => `
    <div class="store-edit-row">
      <input class="store-name-edit" data-store-id="${s.id}"
        value="${esc(s.name)}" maxlength="30"
        autocomplete="off" spellcheck="false">
    </div>`).join('');
}
```

- [ ] **Step 3: Add `renameStore()` and `addStore()` functions**

```js
function renameStore(id, name) {
  name = name.trim();
  if (!name) return;
  const s = storeRegistry.find(s => s.id === id);
  if (!s || s.name === name) return;
  s.name = name;
  saveStores();
  renderStoreSwitcher();
}

function addStore(name) {
  name = name.trim();
  if (!name) return;
  const id = 'store_' + uid();
  storeRegistry.push({ id, name, type: 'grocery' });
  saveStores();
  renderStoreListSettings();
  renderStoreSwitcher();
}
```

- [ ] **Step 4: Wire store management events**

Find `document.getElementById('settingsBtn').addEventListener('click', openSettings)`. After the settings event wiring, add:

```js
document.getElementById('addStoreBtn').addEventListener('click', () => {
  const name = prompt('New store name:');
  if (name && name.trim()) addStore(name);
});

document.getElementById('storeListSettings').addEventListener('blur', e => {
  const input = e.target.closest('.store-name-edit');
  if (input) renameStore(input.dataset.storeId, input.value);
}, true);

document.getElementById('storeListSettings').addEventListener('keydown', e => {
  const input = e.target.closest('.store-name-edit');
  if (!input) return;
  if (e.key === 'Enter' || e.key === 'Escape') {
    renameStore(input.dataset.storeId, input.value);
    input.blur();
  }
});
```

- [ ] **Step 5: Update `openSettings()` to render the store list**

Find `function openSettings()`. Inside the function, add a call to `renderStoreListSettings()`:

```js
function openSettings() {
  document.getElementById('appVersionLabel').textContent = APP_VERSION;
  document.getElementById('storageStatusLabel').textContent =
    idbAvailable ? 'localStorage + IDB' : 'localStorage only';
  renderStoreListSettings();
  document.getElementById('settingsOverlay').classList.add('open');
}
```

- [ ] **Step 6: Verify in browser**

1. Open settings (gear icon). A "Stores" section appears showing "Supermarkt" and "DM" inputs.
2. Rename "Supermarkt" to "Kaufland" (click in input, edit, blur). Store pill in header updates.
3. Tap "+ Add store" → enter "Aldi". Third pill appears.
4. Switch to "Aldi" — all items move to unknown (no Aldi history).

---

## Task 8 — Store-Scoped Autocomplete

**Files:**
- Modify: `index.html` — AUTOCOMPLETE `buildAcHtml()` and `renderAcInto()`

### Goal
Update the autocomplete dropdown to show store-specific badges (● for hist, zone label for zone) based on the active store.

- [ ] **Step 1: Update `buildAcHtml()` to accept `storeId`**

Find `function buildAcHtml(matches, queryLen)` and replace:

```js
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
```

- [ ] **Step 2: Update `renderAcInto()` to pass storeId**

Find `function renderAcInto(query, acEl)` and replace:

```js
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
}
```

- [ ] **Step 3: Update `renderAc()` (no signature change needed)**

`renderAc()` calls `renderAcInto()` without a storeId — the default in `renderAcInto` handles it. Verify the existing call:

```js
function renderAc(query) {
  renderAcInto(query, document.getElementById('acList'));
}
```

This is already correct (will use `state.currentStoreId` via the default).

- [ ] **Step 4: Verify in browser**

1. With Supermarkt active, type part of an item name that has history (e.g., "mil"). Autocomplete should show "●" badge if ≥2 trips, zone label if zone is set.
2. Switch to DM. Type the same prefix. Badge should be absent (no DM history yet) or show DM-specific zone if set.

---

## Task 9 — Backup Export/Import for Schema v2

**Files:**
- Modify: `index.html` — SETTINGS `exportBackup()`, `importBackupFile()`

### Goal
Bump backup schema to 2 and include `storeRegistry`. Import must handle both schema 1 (run migration) and schema 2 (load directly).

- [ ] **Step 1: Update `exportBackup()`**

Find `function exportBackup()` and replace it:

```js
function exportBackup() {
  const payload = {
    app: 'market-list',
    schema: 2,
    appVersion: APP_VERSION,
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
```

- [ ] **Step 2: Update `importBackupFile()` to handle both schema versions**

Find `function importBackupFile(file)` and replace it:

```js
function importBackupFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let payload;
    try { payload = JSON.parse(String(reader.result)); }
    catch (_) { showToast('Invalid backup file'); return; }

    if (!payload || payload.app !== 'market-list' || !payload.data) {
      showToast('Not a Market List backup'); return;
    }

    const ok = confirm('Replace your current list, history, recipes and store settings with this backup? This cannot be undone.');
    if (!ok) return;

    // Write state, history, recipes always
    const keysToRestore = [STORAGE_KEY, HISTORY_KEY, RECIPES_KEY];
    if (payload.schema >= 2) keysToRestore.push(STORES_KEY);

    for (const key of keysToRestore) {
      const v = payload.data[key];
      if (v == null) localStorage.removeItem(key);
      else           localStorage.setItem(key, v);
    }

    // If schema 1 backup: storeRegistry will be missing — load() will create defaults
    // and migrateHistoryIfNeeded() will convert history to store-scoped shape.
    if (!payload.data[STORES_KEY]) {
      localStorage.removeItem(STORES_KEY);
    }

    // Reset in-memory state and reload everything from storage.
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
```

- [ ] **Step 3: Verify export/import round-trip**

1. Add some items, record a trip, rename a store.
2. Export backup from settings. Open the JSON — verify `schema: 2` and `storeRegistry` key.
3. Reset all data. Import the backup. Verify the store names, items, and history are restored correctly.
4. Export a schema-1-shaped backup (manually edit a backup file: remove `storeRegistry` key and set `schema: 1`). Import it — verify app migrates the history and creates default stores.

---

## Task 10 — Reorder Mode Smoke Test

**Files:**
- No code changes — verification only.

### Goal
Confirm drag-reorder still works after the render() restructuring. The reorder button threshold (`knownItems.length > 1`) is already written correctly in Task 6's render() replacement.

- [ ] **Step 1: Verify drag-and-drop works**

1. With Supermarkt active, add 3+ items that have `grocery_main` history (sort badge shows "●" or a zone label).
2. Enable reorder mode (hamburger icon in header — should be visible).
3. Long-press + drag an item. Verify items reorder and the new order is saved after release.
4. The unknown-section items (inside `<details>`) do not show drag handles. Confirm.

- [ ] **Step 2: Verify reorder button hides when all items are unknown**

1. Switch to DM. All items appear in "Unknown availability" section.
2. Reorder button should be hidden (`knownItems.length === 0`, which is `< 2`).
3. Switch back to Supermarkt. Reorder button reappears if ≥2 known items exist.

---

## Acceptance Criteria Verification

After all tasks are complete, verify each criterion:

- [ ] **Existing data unchanged:** Clear app storage, add mock old-format data via DevTools, reload — items appear under "Supermarkt" correctly.
- [ ] **DM switching:** Switch to DM — items show in "Unknown availability" section.
- [ ] **Trip learning:** Add items at DM, check them off, record trip. Switch away and back to DM — items move to known section with DM history.
- [ ] **Zone picker store-scoped:** Add item with "ENT" zone at Supermarkt. Switch to DM — indicator shows "—" (no DM data). Switch back — shows ENT.
- [ ] **Not sold here:** Mark item "Not sold at DM" while DM is active — item disappears. Switch to Supermarkt — item is still visible.
- [ ] **Collapsible unknown:** Expand the unknown section. Re-render (toggle an item) — unknown section stays expanded.
- [ ] **Backup schema 2:** Export includes `storeRegistry`. Import of schema-1 backup migrates correctly.
- [ ] **Recipes unaffected:** Add a recipe, add it to list — items appear on the unified list, work across stores.
- [ ] **PWA/SW unaffected:** App installs and works offline.
