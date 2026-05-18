// Entry point — wires module hooks and runs init().
//
// Dependency graph (DAG): uid → state → scoring → render → events → app.js.
// state.js cannot import from render/events, so render-and-save-error hooks
// are injected here. The sort function used by load()'s migration is likewise
// injected (scoring depends on state, so state can't import sorted).

import {
  setRenderHooks, setSortFn,
  installMirror, restoreFromIdbIfNeeded, backfillIdbFromLocalStorage, load,
} from './js/state.js';
import { sorted } from './js/scoring.js';
import {
  render, renderRecipes, renderView,
  showToast, showStorageWarningBanner,
} from './js/render.js';
// Side-effect imports — these modules attach DOM event listeners at load time.
import './js/events.js';
import './js/settings.js';

// Wire the hooks state.js needs before any save or first render fires.
setRenderHooks({
  renderList:    render,
  renderRecipes,
  onQuotaWarn:   showStorageWarningBanner,
  onSaveError:   () => showToast('Save error — check your browser storage settings.'),
});
setSortFn(sorted);

// Patch localStorage to mirror writes to IndexedDB. Done after hooks are wired
// so a quota error during load() can show a banner.
installMirror();

(async function init() {
  try { await restoreFromIdbIfNeeded(); } catch (_) {}
  load();
  // Make sure IDB mirror has whatever localStorage currently has.
  backfillIdbFromLocalStorage().catch(() => {});
  renderView();
})();
