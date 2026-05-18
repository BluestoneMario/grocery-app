// Scoring and availability — pure functions over state.history / storeRegistry.

import { nameKey } from './uid.js';
import { history, storeRegistry } from './state.js';

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
export function score(item, storeId) {
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
export function compactHistory(histArr) {
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

export function indicator(item, storeId) {
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

export function sorted(items, storeId) {
  return [...items].sort((a, b) => {
    if (a.checked !== b.checked) return a.checked ? 1 : -1;
    return score(a, storeId) - score(b, storeId);
  });
}

export function getAvailability(item, storeId) {
  if (!storeId) return 'unknown';
  const h = history[nameKey(item.name)];
  if (h && h.notAt && h.notAt.includes(storeId)) return 'unavailable';
  if (h && h.stores && h.stores[storeId]) return 'known';
  return 'unknown';
}

// If item is unknown at `storeId` but explicitly known at another store of the
// same type (and not on `notAt`), return that source storeId so callers can
// surface an inferred-availability badge. Otherwise null.
export function getInferredStore(item, storeId) {
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
