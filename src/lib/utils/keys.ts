// Keyboard binding matching for the configurable shortcuts. A binding is a
// single key ("z", " ", "shift") or an optional "mod+" prefix followed by an
// optional "shift+", where mod is the platform's command modifier.

// WebKitGTK reports chords it cannot resolve (Ctrl+Shift+Tab) as "Unidentified";
// e.code still names the physical key.
export function keyToken(e: KeyboardEvent): string {
  const key = e.key.toLowerCase();
  if (key !== "unidentified") return key;
  return e.code.toLowerCase().replace(/^(key|digit)/, "");
}

export function matchesBinding(e: KeyboardEvent, binding: string): boolean {
  // Not trimmed: space is a token of its own (camera up, and Shift+Space in a
  // chord), and a trim would turn the token after a prefix into nothing.
  const combo = binding.toLowerCase();
  if (!combo) return false;
  let token = combo;
  const mod = token.startsWith("mod+");
  if (mod) token = token.slice(4);
  const shift = token.startsWith("shift+");
  if (shift) token = token.slice(6);
  if (!token) return false;
  const sameKey = keyToken(e) === token;
  if (mod) return sameKey && (e.ctrlKey || e.metaKey) && !e.altKey && e.shiftKey === shift;
  // A plain binding ignores shift unless it names it, so Shift+1 still fires "1".
  return sameKey && !e.ctrlKey && !e.metaKey && !e.altKey && (!shift || e.shiftKey);
}
