const NAMED_KEYS: Record<string, string> = { tab: "Tab", pageup: "Page Up", pagedown: "Page Down" };

export function formatKeyName(key: string): string {
  if (key.startsWith("shift+")) return "Shift+" + formatKeyName(key.slice(6));
  if (key.startsWith("mod+")) return "Ctrl+" + formatKeyName(key.slice(4));
  if (key === " ") return "Space";
  if (key === "control") return "Ctrl";
  if (key === "shift") return "Shift";
  if (key.startsWith("arrow")) return "Arrow " + key.charAt(5).toUpperCase() + key.slice(6);
  if (NAMED_KEYS[key]) return NAMED_KEYS[key];
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

export function isTexture(path: string) {
  return /\.(png|jpe?g|exr|tiff?)$/i.test(path);
}
