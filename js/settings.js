// Settings overlay, backup/restore, store management, service-worker registration.

import { uid } from './uid.js';
import {
  state, history, recipes, storeRegistry, ui,
  setState, load,
  replaceState, replaceHistory, replaceRecipes, replaceStoreRegistry,
  STORE_TYPES, STORE_TYPE_SHORT, DEFAULT_STORES,
  STORAGE_KEY, HISTORY_KEY, RECIPES_KEY, STORES_KEY, SHOW_SORT_BADGES_KEY, TRACKED_KEYS,
  idbAvailable,
} from './state.js';
import { renderView, renderStoreSwitcher, render, showToast, esc } from './render.js';

// ─── Backup / restore / reset ────────────────────────────────────────────────

export function exportBackup() {
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
    replaceHistory({});
    replaceRecipes([]);
    replaceStoreRegistry([]);
    replaceState({ items: [], currentStoreId: 'grocery_main', session: { id: uid(), storeId: 'grocery_main', order: [] }, ordered: false });
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
  replaceHistory({});
  replaceRecipes([]);
  replaceStoreRegistry(DEFAULT_STORES.map(s => ({ ...s })));
  replaceState({ items: [], currentStoreId: 'grocery_main', session: { id: uid(), storeId: 'grocery_main', order: [] }, ordered: false });
  for (const key of TRACKED_KEYS) localStorage.removeItem(key);
  setState({}, { historyChanged: true, recipesChanged: true, storesChanged: true, skipRender: true });
  renderView();
  showToast('All data reset');
}

// ─── Settings store list ─────────────────────────────────────────────────────

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
  setState({}, { storesChanged: true });
}

function renameStore(id, name) {
  name = name.trim();
  if (!name) return;
  const s = storeRegistry.find(s => s.id === id);
  if (!s || s.name === name) return;
  s.name = name;
  setState({}, { storesChanged: true, skipRender: true });
  renderStoreSwitcher();
}

function addStore(name, type = 'supermarket') {
  name = name.trim();
  if (!name) return;
  if (!STORE_TYPES.some(t => t.value === type)) type = 'supermarket';
  const id = 'store_' + uid();
  storeRegistry.push({ id, name, type });
  setState({}, { storesChanged: true, skipRender: true });
  renderStoreListSettings();
  renderStoreSwitcher();
}

function showSettingsAddStoreForm() {
  const slot = document.getElementById('addStoreSlot');
  if (!slot) return;
  ui.addingStoreType = 'supermarket';
  const typeBtns = STORE_TYPES.map(t =>
    `<button class="store-add-type-opt${t.value === ui.addingStoreType ? ' active' : ''}" data-settings-form-type="${t.value}">${STORE_TYPE_SHORT[t.value]}</button>`
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
  addStore(name, ui.addingStoreType);
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

function updateSortBadgesToggleLabel() {
  document.getElementById('toggleSortBadgesBtn').textContent =
    `Show sort badges: ${ui.showSortBadges ? 'ON' : 'OFF'}`;
}

// ─── Event listeners ─────────────────────────────────────────────────────────

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
document.getElementById('toggleSortBadgesBtn').addEventListener('click', () => {
  ui.showSortBadges = !ui.showSortBadges;
  localStorage.setItem(SHOW_SORT_BADGES_KEY, String(ui.showSortBadges));
  updateSortBadgesToggleLabel();
  render();
});

// The storage-warning banner export button is wired to dispatch a custom event
// (render.js can't import settings.js without breaking the DAG).
window.addEventListener('marketlist:request-export-backup', () => exportBackup());

updateSortBadgesToggleLabel();
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
    ui.addingStoreType = typeBtn.dataset.settingsFormType;
    document.querySelectorAll('#addStoreSlot .store-add-type-opt').forEach(b => {
      b.classList.toggle('active', b.dataset.settingsFormType === ui.addingStoreType);
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

// ─── Service worker registration ─────────────────────────────────────────────

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
