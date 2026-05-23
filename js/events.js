// UI action functions + delegated event listeners for the list, recipes,
// autocomplete, add form, view toggle, and done-shopping dialog.
// Settings overlay and backup/restore live in settings.js.

import { uid, nameKey } from './uid.js';
import {
  state, history, recipes, storeRegistry, ui, pendingDeleteIds,
  setState, replaceRecipes,
  STORE_TYPES, STORE_TYPE_SHORT,
} from './state.js';
import { sorted, score, compactHistory } from './scoring.js';
import {
  render, renderRecipes, renderView, renderStoreSwitcher,
  showToast, flushPendingToastAction,
  toggleNote, openRecipePanel, setRecipeEditing,
  refreshRecipeItemsDOM, toggleRecipePanel,
  recipeCountLabel,
  closeAc, closeAllRecipeAc, closeRecipeAc, renderAcInto, renderAc,
} from './render.js';

// ─── Actions — list ──────────────────────────────────────────────────────────

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

  const existing = state.items.find(i => nameKey(i.name) === key);
  if (existing) {
    showToast(`${existing.name} is already on the list`);
  } else {
    const newItem = { id: uid(), name, checked: false, comment: '' };
    insertItem(newItem);
    ui.lastAddedId = newItem.id;
  }
  const updates = state.ordered ? {} : { ordered: true };
  setState(updates, { historyChanged: histChanged });
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
      setTimeout(() => setState({}), 200);
    } else {
      setState({});
    }
  } else {
    item.checked = false;
    state.session.order = state.session.order.filter(x => x !== id);
    setState({});
  }
}

function startRenameItem(id) {
  if (ui.currentRenameItemId === id) return;
  if (ui.currentRenameItemId) commitRenameItem();

  const item = state.items.find(i => i.id === id);
  if (!item) return;
  const itemEl = document.querySelector(`.item[data-id="${id}"]`);
  if (!itemEl) return;
  const nameEl = itemEl.querySelector('.item-name');
  if (!nameEl) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'item-rename-input';
  input.value = item.name;
  input.maxLength = 60;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.dataset.itemId = id;
  nameEl.replaceWith(input);

  ui.currentRenameItemId = id;
  input.focus();
  input.select();
}

function commitRenameItem() {
  if (!ui.currentRenameItemId) return;
  const id = ui.currentRenameItemId;
  ui.currentRenameItemId = null;
  const input = document.querySelector(`.item-rename-input[data-item-id="${id}"]`);
  const item = state.items.find(i => i.id === id);
  if (!input || !item) { render(); return; }

  const newName = input.value.trim();
  if (!newName || newName === item.name) { render(); return; }

  const oldKey = nameKey(item.name);
  const newKey = nameKey(newName);
  if (oldKey !== newKey && history[oldKey]) {
    history[newKey] = history[oldKey];
    delete history[oldKey];
  }
  item.name = newName;
  setState({}, { historyChanged: true });
}

function cancelRenameItem() {
  if (!ui.currentRenameItemId) return;
  ui.currentRenameItemId = null;
  render();
}

function removeItem(id) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  if (pendingDeleteIds.has(id)) return;

  // Commit any prior in-flight undo before starting a new one — the user has
  // moved on, so the previous toast's timeout effectively expires now.
  flushPendingToastAction();

  pendingDeleteIds.add(id);

  const showUndoToast = () => {
    showToast(`Removed ${item.name}`, {
      label: 'UNDO',
      onClick: () => {
        // Pull the item back into the rendered list. It is still in state.items;
        // render() will recreate the row with a fresh itemIn animation, landing
        // it in the position dictated by its score.
        pendingDeleteIds.delete(id);
        render();
      },
      onTimeout: () => {
        pendingDeleteIds.delete(id);
        state.items = state.items.filter(i => i.id !== id);
        state.session.order = state.session.order.filter(x => x !== id);
        setState({});
      },
    });
  };

  const el = document.querySelector(`.item[data-id="${id}"]`);
  if (el) {
    // Play itemOut, then drop the element from the DOM and surface the toast.
    // Using a setTimeout rather than animationend so the reduced-motion path
    // (no keyframes defined for itemOut) still resolves on time.
    el.classList.add('removing');
    setTimeout(() => {
      el.remove();
      showUndoToast();
    }, 200);
  } else {
    showUndoToast();
  }
}

// recordTrip() saves each checked item's position in the trip to its per-store
// hist array as a raw entry { sid, pos, recordedAt }, then runs compactHistory
// on that array so it can never grow past MAX_RAW_TRIPS + 1 entries on disk.
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

  state.items = state.items.filter(i => !i.checked);
  state.session = { id: uid(), storeId: state.currentStoreId, order: [] };
  setState({}, { historyChanged: histChanged });
  showToast(n > 0 ? `Trip recorded — ${n} item${n !== 1 ? 's' : ''} learned` : 'List reset');
}

// ─── Actions — recipes ───────────────────────────────────────────────────────

function createRecipe() {
  const r = { id: uid(), name: 'New Recipe', items: [], type: 'main' };
  recipes.unshift(r);
  setState({}, { recipesChanged: true });
  setTimeout(() => {
    openRecipePanel(r.id);
    setRecipeEditing(r.id, true);
    const nameInput = document.querySelector(`.recipe-name-input[data-recipe-id="${r.id}"]`);
    if (nameInput) { nameInput.focus(); nameInput.select(); }
  }, 60);
}

function deleteRecipe(id) {
  replaceRecipes(recipes.filter(r => r.id !== id));
  setState({}, { recipesChanged: true });
}

function renameRecipe(id, newName) {
  const r = recipes.find(r => r.id === id);
  if (!r) return;
  const trimmed = newName.trim();
  if (trimmed) r.name = trimmed;
  setState({}, { recipesChanged: true, skipRender: true });
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
  setState({}, { recipesChanged: true, skipRender: true });
  refreshRecipeItemsDOM(recipeId);
  return true;
}

function removeRecipeItem(recipeId, itemId) {
  const r = recipes.find(r => r.id === recipeId);
  if (!r) return;
  r.items = r.items.filter(i => i.id !== itemId);
  setState({}, { recipesChanged: true, skipRender: true });
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

  let histChanged = false;
  const storeId = state.currentStoreId;

  itemsToAdd.forEach(ri => {
    const key = nameKey(ri.name);

    if (!history[key]) {
      history[key] = { displayName: ri.name, comments: [], stores: {}, notAt: [] };
      histChanged = true;
    } else {
      if (!history[key].stores)   { history[key].stores   = {}; histChanged = true; }
      if (!history[key].notAt)    { history[key].notAt    = []; histChanged = true; }
      if (!history[key].comments) { history[key].comments = []; histChanged = true; }
    }

    if (storeId && !history[key].stores[storeId]) {
      history[key].stores[storeId] = { zone: null, hist: [] };
      histChanged = true;
    }

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

  ui.currentView = 'list';
  setState({}, { skipRender: true, historyChanged: histChanged });
  renderView();
  const n = itemsToAdd.length;
  const msg = n === r.items.length
    ? `${r.name} added to list`
    : `${r.name} — ${n} of ${r.items.length} items added`;
  showToast(msg);
}

// ─── Store switcher actions ──────────────────────────────────────────────────

function showAddStoreForm() {
  const el = document.getElementById('storeSwitcher');
  if (!el) return;
  ui.addingStoreType = 'supermarket';
  const typeBtns = STORE_TYPES.map(t =>
    `<button class="store-add-type-opt${t.value === ui.addingStoreType ? ' active' : ''}" data-store-form-type="${t.value}">${STORE_TYPE_SHORT[t.value]}</button>`
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
  const newStore = { id: 'store_' + uid(), name, type: ui.addingStoreType };
  storeRegistry.push(newStore);
  state.currentStoreId = newStore.id;
  state.items = sorted(state.items, newStore.id);
  ui.unknownSectionOpen = false;
  renderStoreSwitcher();
  setState({}, { storesChanged: true });
  showToast('Store added');
}

function cancelAddStoreForm() {
  renderStoreSwitcher();
}

function switchStore(id) {
  if (id === state.currentStoreId) return;
  state.currentStoreId = id;
  state.items = sorted(state.items, id);
  ui.unknownSectionOpen = false;
  renderStoreSwitcher();
  setState({});
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
  setState({}, { historyChanged: true });
}

// ─── Reorder + drag ──────────────────────────────────────────────────────────

// Pointer drag state (ephemeral, never persisted)
let dragEl    = null;
let dragClone = null;
let dragOffY  = 0;

function toggleReorderMode() {
  ui.reorderMode = !ui.reorderMode;
  const btn = document.getElementById('reorderBtn');
  if (btn) btn.classList.toggle('active', ui.reorderMode);
  render();
}

document.getElementById('reorderBtn').addEventListener('click', toggleReorderMode);

// Pointer drag — fires on listRoot so it only activates inside the list
document.getElementById('listRoot').addEventListener('pointerdown', e => {
  if (!ui.reorderMode) return;
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

  setState({});
}

// ─── Swipe-to-delete ─────────────────────────────────────────────────────────
// Left-swipe past SWIPE_THRESHOLD on a list item triggers the same undo-able
// delete flow as the × button. Disabled in reorder mode so it never fights
// the drag-to-reorder handler (which only fires from .drag-handle).

const SWIPE_THRESHOLD = 60;

let swipeState     = null;
let snapBackTimer  = null;

document.getElementById('listRoot').addEventListener('pointerdown', e => {
  if (ui.reorderMode) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  // Don't start swiping when the user is interacting with text inputs or the
  // reorder drag handle — those have their own gestures.
  if (e.target.closest('input, .item-rename-input, .drag-handle')) return;

  const itemEl = e.target.closest('.item');
  if (!itemEl) return;
  if (itemEl.classList.contains('removing')) return;
  if (pendingDeleteIds.has(itemEl.dataset.id)) return;

  const main = itemEl.querySelector('.item-main');
  if (!main) return;

  // If a snap-back from a prior swipe is still in flight, cancel it so it
  // doesn't wipe the inline transform mid-gesture.
  if (snapBackTimer) { clearTimeout(snapBackTimer); snapBackTimer = null; }

  swipeState = {
    el: itemEl,
    main,
    id: itemEl.dataset.id,
    startX: e.clientX,
    startY: e.clientY,
    pointerId: e.pointerId,
    committed: false,
    armed: false,
    dx: 0,
  };
});

window.addEventListener('pointermove', e => {
  if (!swipeState) return;
  if (e.pointerId !== swipeState.pointerId) return;

  const dx = e.clientX - swipeState.startX;
  const dy = e.clientY - swipeState.startY;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  if (!swipeState.committed) {
    // Wait for enough movement to classify the gesture.
    if (absDx < 8 && absDy < 8) return;
    // Require a clearly horizontal, leftward gesture; otherwise let the touch
    // fall through to vertical scroll (touch-action: pan-y on .item).
    if (dx >= 0 || absDx < absDy * 2) {
      swipeState = null;
      return;
    }
    swipeState.committed = true;
    swipeState.el.classList.add('swipe-active');
    swipeState.main.style.transition = 'none';
    try { swipeState.el.setPointerCapture(e.pointerId); } catch (_) {}
    // Swallow the click that would otherwise fire on pointerup so a committed
    // swipe doesn't also toggle the checkbox or open the note panel.
    const suppress = ev => { ev.stopPropagation(); ev.preventDefault(); };
    document.addEventListener('click', suppress, { capture: true, once: true });
    setTimeout(() => document.removeEventListener('click', suppress, true), 600);
  }

  e.preventDefault();

  const tx = Math.min(0, dx);
  swipeState.dx = tx;
  swipeState.main.style.transform = `translateX(${tx}px)`;

  const armed = -tx >= SWIPE_THRESHOLD;
  if (armed !== swipeState.armed) {
    swipeState.armed = armed;
    swipeState.el.classList.toggle('swipe-armed', armed);
  }
}, { passive: false });

function onSwipeEnd(e) {
  if (!swipeState) return;
  if (e.pointerId !== swipeState.pointerId) return;

  if (!swipeState.committed) { swipeState = null; return; }

  const s = swipeState;
  swipeState = null;

  s.el.classList.remove('swipe-armed');

  if (-s.dx >= SWIPE_THRESHOLD) {
    // Past threshold — feed into the same undo-able delete flow as the × button.
    // The .item-main transform stays where it is; the .item.removing animation
    // collapses the whole row, so the leftover translate is immaterial.
    removeItem(s.id);
  } else {
    // Snap back.
    s.main.style.transition = 'transform 0.2s ease';
    s.main.style.transform = 'translateX(0)';
    if (snapBackTimer) clearTimeout(snapBackTimer);
    snapBackTimer = setTimeout(() => {
      snapBackTimer = null;
      s.el.classList.remove('swipe-active');
      s.main.style.transition = '';
      s.main.style.transform = '';
    }, 220);
  }
}

window.addEventListener('pointerup', onSwipeEnd);
window.addEventListener('pointercancel', onSwipeEnd);

// ─── Events — list (delegated) ───────────────────────────────────────────────

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
      if (item) { item.comment = val; setState({}, { skipRender: true }); }
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
  if (deleteTarget) { removeItem(deleteTarget.dataset.delete); return; }

  // Direct tap on the name span enters rename mode. Only matches the span
  // itself (not .item-main), so the checkbox tap target stays unaffected.
  const nameTarget = e.target.closest('.item-name');
  if (nameTarget) {
    const itemEl = nameTarget.closest('.item');
    if (itemEl) startRenameItem(itemEl.dataset.id);
  }
});

document.getElementById('listRoot').addEventListener('keydown', e => {
  const input = e.target.closest('.item-rename-input');
  if (!input) return;
  if (e.key === 'Enter')       { e.preventDefault(); commitRenameItem(); }
  else if (e.key === 'Escape') { e.preventDefault(); cancelRenameItem(); }
});

document.getElementById('listRoot').addEventListener('blur', e => {
  if (e.target.closest('.item-rename-input')) commitRenameItem();
}, true);

document.getElementById('listRoot').addEventListener('input', e => {
  const noteInput = e.target.closest('.note-input');
  if (!noteInput) return;
  const id = noteInput.dataset.itemId;
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  item.comment = noteInput.value;
  setState({}, { skipRender: true });
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

// ─── Events — recipes (delegated) ────────────────────────────────────────────

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
      setState({}, { recipesChanged: true, skipRender: true });
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

// Bulk paste — multi-line clipboard contents become one ingredient per line.
// A trailing parenthesised value on a line is treated as the amount, e.g.
// "Oat milk (500ml)" → name "Oat milk", amount "500ml".
document.getElementById('recipesRoot').addEventListener('paste', e => {
  const ingInput = e.target.closest('.recipe-ingredient-input');
  if (!ingInput) return;
  const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
  if (!text.includes('\n')) return; // single-line paste falls through to default

  e.preventDefault();
  const recipeId = ingInput.dataset.recipeId;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  let added = 0;
  for (const line of lines) {
    // Trailing "(amount)" — non-greedy on the name, no nested parens.
    const m = line.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
    const name   = m ? m[1].trim() : line;
    const amount = m ? m[2].trim() : '';
    if (!name) continue;
    if (addRecipeItem(recipeId, name, amount)) added++;
  }

  ingInput.value = '';
  closeRecipeAc(recipeId);
  ingInput.focus();
  showToast(`${added} ingredient${added !== 1 ? 's' : ''} added`);
});

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

// ─── Autocomplete + add form ─────────────────────────────────────────────────

const addInput = document.getElementById('addInput');
const zoneRow  = document.getElementById('zoneRow');
const zoneBtns = document.querySelectorAll('.zone-btn');

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
    ui.addingStoreType = typeBtn.dataset.storeFormType;
    document.querySelectorAll('.store-add-type-opt').forEach(b => {
      b.classList.toggle('active', b.dataset.storeFormType === ui.addingStoreType);
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
  if (addItem(name, ui.pendingZone)) {
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
    if (ui.pendingZone === s) {
      clearZone();
    } else {
      ui.pendingZone = s;
      zoneBtns.forEach(b => b.classList.toggle('active', b === btn));
    }
  });
});

function clearZone() {
  ui.pendingZone = null;
  zoneBtns.forEach(b => b.classList.remove('active'));
}

// ─── View toggle ─────────────────────────────────────────────────────────────

document.querySelectorAll('.toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.view === ui.currentView) return;
    ui.currentView = btn.dataset.view;
    renderView();
  });
});

// ─── Done shopping dialog ────────────────────────────────────────────────────

document.getElementById('doneBtn').addEventListener('click', () => {
  const n = state.items.filter(i => i.checked).length;
  if (n === 0) return;

  document.getElementById('dialogSummary').textContent =
    `${n} item${n !== 1 ? 's' : ''} checked off — order will be recorded.`;

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
