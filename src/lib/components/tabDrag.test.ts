import { describe, expect, it } from "vitest";
import { displacedShift, dragTargetIndex } from "./tabDrag";

// Three 100px slots starting at x=0, 100, 200.
const rects = [
  { left: 0, width: 100 },
  { left: 100, width: 100 },
  { left: 200, width: 100 },
];

describe("dragTargetIndex", () => {
  it("returns the slot under the pointer", () => {
    expect(dragTargetIndex(rects, 10)).toBe(0);
    expect(dragTargetIndex(rects, 150)).toBe(1);
    expect(dragTargetIndex(rects, 250)).toBe(2);
  });

  it("clamps past both ends", () => {
    expect(dragTargetIndex(rects, -50)).toBe(0);
    expect(dragTargetIndex(rects, 1000)).toBe(2);
  });

  it("returns 0 for an empty strip", () => {
    expect(dragTargetIndex([], 42)).toBe(0);
  });
});

describe("displacedShift", () => {
  it("leaves the dragged chip and non-crossed chips alone", () => {
    expect(displacedShift(0, 0, 2, 120)).toBe(0);
    expect(displacedShift(3, 0, 2, 120)).toBe(0);
  });

  it("pulls chips left when dragging right", () => {
    expect(displacedShift(1, 0, 2, 120)).toBe(-120);
    expect(displacedShift(2, 0, 2, 120)).toBe(-120);
  });

  it("pushes chips right when dragging left", () => {
    expect(displacedShift(0, 2, 0, 120)).toBe(120);
    expect(displacedShift(1, 2, 0, 120)).toBe(120);
    expect(displacedShift(2, 2, 0, 120)).toBe(0);
  });

  it("shifts nothing when the target is the dragged slot", () => {
    expect(displacedShift(1, 1, 1, 120)).toBe(0);
  });
});
