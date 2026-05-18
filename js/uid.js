// Pure utilities — no DOM, no state, no other module deps.

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function nameKey(name) {
  return name.toLowerCase().trim();
}
