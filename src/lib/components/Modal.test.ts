// @vitest-environment happy-dom
import { beforeEach, afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { mount, unmount, tick } from "svelte";
import Harness from "./__tests__/modal-harness.svelte";

let onCloseA: Mock<() => void>;
let onCloseB: Mock<() => void>;
let instance: ReturnType<typeof mount> | null = null;

// Simulates a key event coming from the page (svelte:window listeners).
function pressEscape(): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

function pressTab(): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML = "";
  onCloseA = vi.fn<() => void>();
  onCloseB = vi.fn<() => void>();
});

afterEach(() => {
  if (instance !== null) unmount(instance);
  instance = null;
});

async function openStack(): Promise<ReturnType<typeof mount>> {
  instance = mount(Harness, { target: document.body, props: { onCloseA, onCloseB } });
  await tick();
  return instance;
}

describe("Modal shell", () => {
  it("Escape closes the top-most modal only", async () => {
    await openStack();
    pressEscape();
    await tick();
    expect(onCloseB).toHaveBeenCalledTimes(1);
    expect(onCloseA).toHaveBeenCalledTimes(0);

    // B left the DOM; Escape now reaches the lower modal A.
    pressEscape();
    await tick();
    expect(onCloseA).toHaveBeenCalledTimes(1);
  });

  it("focus moves into the modal on open and returns to the invoker after close", async () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    await openStack();
    // Opening the modals moved focus into the top modal.
    const topDialog = [...document.querySelectorAll('[role="dialog"]')].at(-1)!;
    expect(topDialog.contains(document.activeElement)).toBe(true);

    pressEscape();
    await tick();
    // Top modal closed: focus went back to the lower modal's content.
    const lowerDialog = document.querySelector('[role="dialog"]')!;
    expect(lowerDialog.contains(document.activeElement)).toBe(true);

    pressEscape();
    await tick();
    expect(document.activeElement).toBe(outside);
  });

  it("keeps Tab focus inside the top-most dialog", async () => {
    await openStack();
    pressTab();
    const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
    const topDialog = dialogs[dialogs.length - 1];
    expect(topDialog.contains(document.activeElement)).toBe(true);
  });
});
