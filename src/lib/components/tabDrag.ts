// Tab-drag maths, kept DOM-free so it unit-tests without a layout engine.

export interface TabRect {
  left: number;
  width: number;
}

// The slot whose horizontal band contains x; clamped to the strip's ends.
export function dragTargetIndex(rects: TabRect[], x: number): number {
  for (let i = 0; i < rects.length; i += 1) {
    if (x < rects[i].left + rects[i].width) return i;
  }
  return Math.max(rects.length - 1, 0);
}

// How far chip `index` slides to open the dragged tab's slot: chips between
// the dragged slot and the target slot move one slot-width, the rest stay put.
export function displacedShift(index: number, from: number, to: number, width: number): number {
  if (index === from || from === to) return 0;
  if (to > from && index > from && index <= to) return -width;
  if (to < from && index >= to && index < from) return width;
  return 0;
}
