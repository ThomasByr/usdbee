// Keyboard binding matching for the configurable shortcuts. A binding is a
// single key ("z", " ", "shift") or "mod+<key>", where mod is the platform's
// command modifier.

export function matchesBinding(e: KeyboardEvent, binding: string): boolean {
  // Space is a binding in its own right (camera up), so it survives the trim.
  const combo = binding === " " ? " " : binding.trim().toLowerCase();
  if (!combo) return false;
  const key = e.key.toLowerCase();
  if (combo.startsWith("mod+")) return (e.ctrlKey || e.metaKey) && key === combo.slice(4);
  return key === combo && !e.ctrlKey && !e.metaKey && !e.altKey;
}
