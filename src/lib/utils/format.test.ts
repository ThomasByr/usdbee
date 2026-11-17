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

  it("spaces the arrow key names", () => {
    expect(formatKeyName("arrowright")).toBe("Arrow Right");
    expect(formatKeyName("arrowleft")).toBe("Arrow Left");
    expect(formatKeyName("arrowup")).toBe("Arrow Up");
  });
});
