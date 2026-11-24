import { describe, expect, it } from "vitest";
import { formatKeyName } from "./format";

describe("formatKeyName", () => {
  it("renders a mod combo as Ctrl+<Key>", () => {
    expect(formatKeyName("mod+p")).toBe("Ctrl+P");
    expect(formatKeyName("mod+ ")).toBe("Ctrl+Space");
  });

  it("keeps the existing single-key labels", () => {
    expect(formatKeyName(" ")).toBe("Space");
    expect(formatKeyName("control")).toBe("Ctrl");
    expect(formatKeyName("shift")).toBe("Shift");
    expect(formatKeyName("z")).toBe("Z");
  });

  it("renders a shift chord as Ctrl+Shift+<Key>", () => {
    expect(formatKeyName("mod+shift+tab")).toBe("Ctrl+Shift+Tab");
  });

  it("names the paging keys", () => {
    expect(formatKeyName("mod+pagedown")).toBe("Ctrl+Page Down");
    expect(formatKeyName("mod+pageup")).toBe("Ctrl+Page Up");
  });

  it("names the tab key", () => {
    expect(formatKeyName("tab")).toBe("Tab");
  });

  it("spaces the arrow key names", () => {
    expect(formatKeyName("arrowright")).toBe("Arrow Right");
    expect(formatKeyName("arrowleft")).toBe("Arrow Left");
    expect(formatKeyName("arrowup")).toBe("Arrow Up");
  });
});
