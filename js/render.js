// Rendering — itemHtml/recipeHtml as the source of truth for row shape;
// render() and renderRecipes() do surgical patching where possible.
// Toast and storage-warning banner live here because they are pure UI.

import { nameKey } from './uid.js';
import { state, history, recipes, storeRegistry, ui, pendingDeleteIds } from './state.js';
import { indicator, getAvailability, getInferredStore } from './scoring.js';

// ─── Store switcher ──────────────────────────────────────────────────────────

export function renderStoreSwitcher() {
  const el = document.getElementById('storeSwitcher');
  if (!el) return;
  if (ui.currentView === 'recipes') {
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

// ─── Escape ───────────────────────────────────────────────────────────────────

export function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Item HTML ───────────────────────────────────────────────────────────────

export function itemHtml(item, draggable = true) {
  const storeId   = state.currentStoreId;
  const store     = storeRegistry.find(s => s.id === storeId);
  const storeName = store ? store.name : 'this store';
  const ind       = indicator(item, storeId);
  const inReorder = draggable && ui.reorderMode && !item.checked;
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

  const newAttr = item.id === ui.lastAddedId ? ' data-new="true"' : '';

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
        ${ui.showSortBadges ? `<span class="sort-badge ${ind.cls}" title="${ind.tip}">${ind.label}</span>` : ''}
        ${isUnavail ? `<button class="unavail-badge" data-avail-toggle="${item.id}" aria-label="Mark ${esc(item.name)} as available at ${esc(storeName)}" title="Not sold at ${esc(storeName)} — tap to restore">✕ ${esc(storeName)}</button>` : ''}
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

// ─── List render ─────────────────────────────────────────────────────────────

export function render() {
  const storeId = state.currentStoreId;
  // Filter out items in the undo window so render() never re-introduces a
  // soft-deleted row. The row's DOM element is owned by removeItem() during
  // its itemOut animation; render() will only see the item again if undo
  // pulls it back out of pendingDeleteIds.
  const all     = state.items.filter(i => !pendingDeleteIds.has(i.id));
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
  if (reorderBtn && ui.currentView === 'list') {
    const show = knownItems.length > 1;
    reorderBtn.style.display = show ? 'flex' : 'none';
    if (!show && ui.reorderMode) {
      ui.reorderMode = false;
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

  // Note: the open-panel snapshot/restore from the previous render() is no
  // longer needed. We now surgically patch existing .item nodes in place
  // instead of replacing listRoot.innerHTML, so an open .item-note-panel and
  // its focused input survive re-renders naturally — no wipe, no re-focus.

  // Drop any "empty" placeholder left over from a prior empty-list render.
  const emptyEl = root.querySelector(':scope > .empty');
  if (emptyEl) emptyEl.remove();

  // Reconcile sections in fixed display order: to-get → unknown → in-cart.
  const showToGetHeader = toGetItems.length > 0 && (checked.length > 0 || unknownItems.length > 0);
  syncToGetSection(root, toGetItems, showToGetHeader);
  syncUnknownSection(root, unknownItems);
  syncInCartSection(root, checked);

  ui.lastAddedId = null;
}

// ─── Surgical render helpers ─────────────────────────────────────────────────
// render() reconciles three sections (to-get / unknown / in-cart) by data-id
// rather than rebuilding listRoot.innerHTML. Each item's existing DOM node is
// patched in place via updateItemDOM(); new items are created from itemHtml()
// and existing items not in the new state are removed. itemHtml() remains
// the single source of truth for row shape — when a structural change (e.g.
// entering reorder mode, toggling sort badges, flipping availability) would
// alter the row's shape, the row is regenerated from itemHtml() rather than
// patched.

function syncToGetSection(root, items, showHeader) {
  let section = root.querySelector(':scope > .list-section[data-section="to-get"]');
  if (items.length === 0) {
    if (section) section.remove();
    return;
  }
  if (!section) {
    section = document.createElement('div');
    section.className = 'list-section';
    section.dataset.section = 'to-get';
  }
  let header = section.querySelector(':scope > .section-header');
  if (showHeader) {
    if (!header) {
      const tmp = document.createElement('div');
      tmp.innerHTML = `
        <div class="section-header">
          <span class="section-label">to get</span>
          <span class="section-count">${items.length}</span>
          <span class="section-line"></span>
        </div>`;
      header = tmp.firstElementChild;
      section.insertBefore(header, section.firstChild);
    } else {
      const countEl = header.querySelector('.section-count');
      if (countEl && countEl.textContent !== String(items.length)) {
        countEl.textContent = items.length;
      }
    }
  } else if (header) {
    header.remove();
  }
  syncSectionItems(section, items, true);
  // Position: first child of listRoot.
  if (root.firstElementChild !== section) {
    root.insertBefore(section, root.firstElementChild);
  }
}

function syncUnknownSection(root, items) {
  let section = root.querySelector(':scope > details.unknown-section');
  if (items.length === 0) {
    if (section) section.remove();
    return;
  }
  if (!section) {
    section = document.createElement('details');
    section.className = 'unknown-section';
    section.innerHTML = `
      <summary>
        <span class="section-label">Unknown availability</span>
        <span class="section-count">${items.length}</span>
        <span class="section-line"></span>
        <span class="unknown-toggle-icon">▾</span>
      </summary>`;
    if (ui.unknownSectionOpen) section.setAttribute('open', '');
    section.addEventListener('toggle', () => {
      ui.unknownSectionOpen = section.open;
    });
  } else {
    const countEl = section.querySelector(':scope > summary .section-count');
    if (countEl && countEl.textContent !== String(items.length)) {
      countEl.textContent = items.length;
    }
    if (section.open !== ui.unknownSectionOpen) section.open = ui.unknownSectionOpen;
  }
  syncSectionItems(section, items, false);
  // Position: after to-get section if it exists, else first.
  const toGet = root.querySelector(':scope > .list-section[data-section="to-get"]');
  const desiredPrev = toGet ?? null;
  if (section.previousElementSibling !== desiredPrev) {
    if (desiredPrev) desiredPrev.after(section);
    else            root.insertBefore(section, root.firstElementChild);
  }
}

function syncInCartSection(root, items) {
  let section = root.querySelector(':scope > .list-section[data-section="in-cart"]');
  if (items.length === 0) {
    if (section) section.remove();
    return;
  }
  if (!section) {
    section = document.createElement('div');
    section.className = 'list-section';
    section.dataset.section = 'in-cart';
    section.innerHTML = `
      <div class="section-header">
        <span class="section-label">in cart</span>
        <span class="section-count">${items.length}</span>
        <span class="section-line"></span>
      </div>`;
  } else {
    const countEl = section.querySelector(':scope > .section-header .section-count');
    if (countEl && countEl.textContent !== String(items.length)) {
      countEl.textContent = items.length;
    }
  }
  syncSectionItems(section, items, true);
  // Position: last child of listRoot.
  if (root.lastElementChild !== section) root.appendChild(section);
}

// Reconcile direct-child .item elements within `container` to match `items`
// in order. New items are created from itemHtml(); existing items are
// patched via updateItemDOM() (or re-created when structural state changed).
function syncSectionItems(container, items, draggable) {
  // Anchor: the element after which items appear (.section-header or summary).
  const header = container.querySelector(':scope > .section-header, :scope > summary');

  const existing = new Map();
  container.querySelectorAll(':scope > .item').forEach(el => existing.set(el.dataset.id, el));
  const desiredIds = new Set(items.map(i => i.id));

  for (const [id, el] of existing) {
    if (!desiredIds.has(id)) {
      el.remove();
      existing.delete(id);
    }
  }

  let prev = header;
  for (const item of items) {
    let el = existing.get(item.id);
    if (!el) {
      const tmp = document.createElement('div');
      tmp.innerHTML = itemHtml(item, draggable);
      el = tmp.firstElementChild;
      if (prev) prev.after(el);
      else      container.insertBefore(el, container.firstChild);
    } else {
      if (itemNeedsRecreate(el, item, draggable)) {
        const tmp = document.createElement('div');
        tmp.innerHTML = itemHtml(item, draggable);
        const fresh = tmp.firstElementChild;
        el.replaceWith(fresh);
        el = fresh;
      } else {
        updateItemDOM(el, item);
      }
      // Move into expected position if needed.
      if (el.previousElementSibling !== prev) {
        if (prev) prev.after(el);
        else      container.insertBefore(el, container.firstChild);
      }
    }
    prev = el;
  }
}

// Returns true if `el`'s structure differs from what itemHtml(item, draggable)
// would produce, requiring a full re-create rather than a field-level patch.
function itemNeedsRecreate(el, item, draggable) {
  const inReorderDesired = draggable && ui.reorderMode && !item.checked;
  const hasReorder = el.classList.contains('reorder-mode');
  if (inReorderDesired !== hasReorder) return true;

  const hasBadge = !!el.querySelector('.sort-badge');
  if (hasBadge !== ui.showSortBadges) return true;

  const storeId = state.currentStoreId;
  const h = history[nameKey(item.name)] || {};
  const isUnavailDesired = !!(h.notAt && h.notAt.includes(storeId));
  const hasUnavailBadge = !!el.querySelector('.unavail-badge');
  if (isUnavailDesired !== hasUnavailBadge) return true;

  return false;
}

// Patch the in-place mutable fields of an existing .item element. Anything
// that would change the row's shape is the job of itemNeedsRecreate +
// itemHtml() — keep this function strictly to text/class/attribute tweaks.
function updateItemDOM(el, item) {
  const storeId = state.currentStoreId;
  const inReorder = ui.reorderMode && !item.checked;

  el.classList.toggle('checked', item.checked);
  el.classList.toggle('reorder-mode', inReorder);

  if (item.id === ui.lastAddedId) {
    if (el.dataset.new !== 'true') el.dataset.new = 'true';
  } else if ('new' in el.dataset) {
    delete el.dataset.new;
  }

  const cb = el.querySelector('.cb');
  if (cb) {
    const ariaVal = String(item.checked);
    if (cb.getAttribute('aria-checked') !== ariaVal) cb.setAttribute('aria-checked', ariaVal);
  }

  const nameEl = el.querySelector('.item-name');
  if (nameEl && nameEl.textContent !== item.name) nameEl.textContent = item.name;

  const comment = item.comment || '';
  let commentEl = el.querySelector('.item-comment');
  if (comment) {
    if (commentEl) {
      if (commentEl.textContent !== comment) commentEl.textContent = comment;
    } else if (nameEl) {
      commentEl = document.createElement('span');
      commentEl.className = 'item-comment';
      commentEl.textContent = comment;
      nameEl.insertAdjacentElement('afterend', commentEl);
    }
  } else if (commentEl) {
    commentEl.remove();
  }

  const badgeEl = el.querySelector('.sort-badge');
  if (badgeEl) {
    const ind = indicator(item, storeId);
    const desiredCls = `sort-badge ${ind.cls}`;
    if (badgeEl.className !== desiredCls)              badgeEl.className = desiredCls;
    if (badgeEl.textContent !== ind.label)             badgeEl.textContent = ind.label;
    if (badgeEl.getAttribute('title') !== ind.tip)     badgeEl.setAttribute('title', ind.tip);
  }

  const noteBtn = el.querySelector('.note-btn');
  if (noteBtn) noteBtn.classList.toggle('has-note', !!comment);
}

// ─── Recipes render ──────────────────────────────────────────────────────────

export function recipeCountLabel(r) {
  return r.items.length === 0 ? 'empty' : `${r.items.length} item${r.items.length !== 1 ? 's' : ''}`;
}

export function recipeItemsListHtml(r) {
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

export function recipeHtml(r) {
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

export function renderRecipes() {
  const root = document.getElementById('recipesRoot');

  // Snapshot any open recipe panel, its editing flag, and the currently-focused
  // input within it before innerHTML wipes the DOM. renderRecipes() can fire
  // from setState() while the user is editing (e.g. creating a new recipe while
  // another panel is open) and would otherwise close the panel and steal focus.
  const openRecipeId = document.querySelector('.recipe-panel.open')
    ?.id?.replace('recipe-panel-', '') ?? null;
  const editingRecipeId = document.querySelector('.recipe.recipe--editing')
    ?.dataset.recipeId ?? null;
  const focusedEl = document.activeElement;
  const focusedClass = ['recipe-name-input', 'recipe-ingredient-input', 'recipe-amount-input']
    .find(c => focusedEl?.classList.contains(c)) ?? null;
  const focusedRecipeId = focusedClass ? focusedEl.dataset.recipeId : null;
  const focusedValue    = focusedClass ? focusedEl.value : null;

  if (recipes.length === 0) {
    root.innerHTML = `
      <div class="recipes-empty">
        <div class="recipes-empty-glyph">RECIPES</div>
        <div class="recipes-empty-msg">No recipes yet.<br>Create one to quickly add items to your list.</div>
      </div>`;
  } else {
    const mains    = recipes.filter(r => (r.type || 'main') !== 'dessert').sort((a, b) => a.name.localeCompare(b.name));
    const desserts = recipes.filter(r => r.type === 'dessert').sort((a, b) => a.name.localeCompare(b.name));
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

  if (openRecipeId) {
    document.getElementById(`recipe-panel-${openRecipeId}`)?.classList.add('open');
  }
  if (editingRecipeId) {
    document.querySelector(`.recipe[data-recipe-id="${editingRecipeId}"]`)
      ?.classList.add('recipe--editing');
  }
  if (focusedClass && focusedRecipeId) {
    const input = document.querySelector(`.${focusedClass}[data-recipe-id="${focusedRecipeId}"]`);
    if (input && focusedValue !== null) input.value = focusedValue;
    input?.focus();
  }
}

export function refreshRecipeItemsDOM(recipeId) {
  const r = recipes.find(r => r.id === recipeId);
  if (!r) return;
  const panel = document.getElementById(`recipe-panel-${recipeId}`);
  if (!panel) return;
  const listEl = panel.querySelector('.recipe-items-list');
  if (listEl) listEl.innerHTML = recipeItemsListHtml(r);
  const countEl = document.querySelector(`.recipe[data-recipe-id="${recipeId}"] .recipe-item-count`);
  if (countEl) countEl.textContent = recipeCountLabel(r);
}

export function clearAllRecipeEditing() {
  document.querySelectorAll('.recipe.recipe--editing').forEach(el => el.classList.remove('recipe--editing'));
}

export function setRecipeEditing(id, editing) {
  const recipeEl = document.querySelector(`.recipe[data-recipe-id="${id}"]`);
  if (!recipeEl) return;
  recipeEl.classList.toggle('recipe--editing', editing);
}

export function openRecipePanel(id) {
  document.querySelectorAll('.recipe-panel.open').forEach(p => p.classList.remove('open'));
  clearAllRecipeEditing();
  const panel = document.getElementById(`recipe-panel-${id}`);
  if (panel) panel.classList.add('open');
}

export function toggleRecipePanel(id) {
  const panel = document.getElementById(`recipe-panel-${id}`);
  if (!panel) return;
  const opening = !panel.classList.contains('open');
  document.querySelectorAll('.recipe-panel.open').forEach(p => p.classList.remove('open'));
  clearAllRecipeEditing();
  closeAllRecipeAc();
  if (opening) panel.classList.add('open');
}

// ─── View switcher ───────────────────────────────────────────────────────────

export function renderView() {
  document.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === ui.currentView);
  });

  const listRoot    = document.getElementById('listRoot');
  const recipesRoot = document.getElementById('recipesRoot');
  const addRow      = document.getElementById('addRow');
  const footer      = document.getElementById('footer');
  const zoneRow     = document.getElementById('zoneRow');

  if (ui.currentView === 'list') {
    listRoot.style.display = '';
    recipesRoot.classList.remove('visible');
    addRow.style.display = '';
    footer.style.display = '';
    render();
    renderStoreSwitcher();
  } else {
    // Exit reorder mode when leaving the list view
    if (ui.reorderMode) {
      ui.reorderMode = false;
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

// ─── Toast ───────────────────────────────────────────────────────────────────

let toastTimer;
// Pending action attached to the currently-visible toast. Resolves with onTimeout
// when the toast naturally expires (or is replaced by another toast). Cleared
// without onTimeout when the user taps the toast's action button.
let pendingToastAction = null;

export function flushPendingToastAction() {
  const p = pendingToastAction;
  pendingToastAction = null;
  if (p && !p.resolved && typeof p.onTimeout === 'function') {
    p.resolved = true;
    p.onTimeout();
  }
}

export function showToast(msg, action) {
  // If a previous toast had a deferred action and is being replaced, commit it
  // now — the user has effectively moved on.
  flushPendingToastAction();

  const el = document.getElementById('toast');
  el.innerHTML = '';
  const msgSpan = document.createElement('span');
  msgSpan.className = 'toast-msg';
  msgSpan.textContent = msg;
  el.appendChild(msgSpan);

  if (action && action.label && typeof action.onClick === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      if (pendingToastAction) pendingToastAction.resolved = true;
      pendingToastAction = null;
      clearTimeout(toastTimer);
      el.classList.remove('show');
      action.onClick();
    });
    el.appendChild(btn);

    if (typeof action.onTimeout === 'function') {
      pendingToastAction = { onTimeout: action.onTimeout, resolved: false };
    }
  }

  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    flushPendingToastAction();
  }, 2600);
}

export function showStorageWarningBanner() {
  if (document.querySelector('.storage-warning-banner')) return;
  const banner = document.createElement('div');
  banner.className = 'storage-warning-banner';
  banner.innerHTML =
    '<span class="swb-msg">Storage full — last change may not have saved. Export a backup to avoid losing data.</span>' +
    '<button class="swb-export">Export backup</button>' +
    '<button class="swb-dismiss" aria-label="Dismiss">✕</button>';
  banner.querySelector('.swb-export').addEventListener('click', () => {
    // Defer to settings.js's exportBackup via a global hook to avoid a cycle.
    window.dispatchEvent(new CustomEvent('marketlist:request-export-backup'));
  });
  banner.querySelector('.swb-dismiss').addEventListener('click', () => banner.remove());
  document.body.prepend(banner);
}

// ─── Note panel ──────────────────────────────────────────────────────────────

export function toggleNote(id) {
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

// ─── Autocomplete ────────────────────────────────────────────────────────────

function buildAcHtml(matches, q, storeId) {
  const names = { 0.1: 'ENT', 0.4: 'MID', 0.7: 'BCK', 0.9: 'CHK' };
  return matches.map(([key, h]) => {
    const display = h.displayName || key.replace(/\b\w/g, c => c.toUpperCase());
    // Locate the match inside the displayed name so the highlight follows
    // substring hits rather than always painting the leading characters.
    const idx    = display.toLowerCase().indexOf(q);
    const before = idx > 0 ? esc(display.slice(0, idx)) : '';
    const hi     = esc(display.slice(Math.max(idx, 0), Math.max(idx, 0) + q.length));
    const after  = esc(display.slice(Math.max(idx, 0) + q.length));
    const sh   = h.stores?.[storeId];
    let badge  = '';
    if (sh && sh.hist && sh.hist.length >= 2) {
      badge = `<span class="ac-badge hist">●</span>`;
    } else if (sh && sh.zone != null) {
      badge = `<span class="ac-badge zone">${names[sh.zone] ?? '~'}</span>`;
    }
    return `<div class="ac-item" data-fill="${esc(display)}"><span>${before}<span class="ac-match">${hi}</span>${after}</span>${badge}</div>`;
  }).join('');
}

export function renderAcInto(query, acEl, storeId) {
  storeId = storeId || state.currentStoreId;
  const q = nameKey(query);
  if (!q) { acEl.classList.remove('open'); acEl.innerHTML = ''; return; }

  const matches = Object.entries(history)
    .filter(([key]) => key !== q && key.includes(q))
    .sort(([a], [b]) => {
      const aPrefix = a.startsWith(q);
      const bPrefix = b.startsWith(q);
      if (aPrefix !== bPrefix) return aPrefix ? -1 : 1;
      return a.localeCompare(b);
    })
    .slice(0, 6);

  if (matches.length === 0) { acEl.classList.remove('open'); acEl.innerHTML = ''; return; }

  acEl.innerHTML = buildAcHtml(matches, q, storeId);
  acEl.classList.add('open');
  acEl.closest('.recipe-panel')?.classList.add('ac-open');
}

export function renderAc(query) {
  renderAcInto(query, document.getElementById('acList'));
}

export function closeAc() {
  const el = document.getElementById('acList');
  el.classList.remove('open');
}

export function closeRecipeAc(recipeId) {
  const el = recipeId ? document.getElementById(`recipe-ac-${recipeId}`) : null;
  if (el) {
    el.classList.remove('open');
    el.innerHTML = '';
    el.closest('.recipe-panel')?.classList.remove('ac-open');
  }
}

export function closeAllRecipeAc() {
  document.querySelectorAll('.recipe-ac.open').forEach(el => {
    el.classList.remove('open');
    el.closest('.recipe-panel')?.classList.remove('ac-open');
    el.innerHTML = '';
  });
}
