// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { mount, unmount, tick } from "svelte";
import type { ValuePayload } from "$lib/stage/types";
import Harness from "./__tests__/attribute-editor-harness.svelte";

const payload = (type: string, data: unknown): ValuePayload => ({ type, data });

let instance: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (instance !== null) unmount(instance);
  instance = null;
});

const textInput = (): HTMLInputElement => document.querySelector<HTMLInputElement>("input.value-editor")!;

const pressEnter = (): void => {
  textInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
};

async function mountEditor(
  value: ValuePayload,
  oncommit: Mock<(value: ValuePayload) => Promise<string | null>>,
) {
  document.body.innerHTML = "";
  instance = mount(Harness, { target: document.body, props: { value, oncommit } });
  await tick();
}

describe("AttributeEditor no-op color guard", () => {
  it("an untouched non-grid color commits nothing on Enter or blur", async () => {
    // 0.5 quantizes to #808080: the round trip is a no-op on the 8-bit grid.
    const oncommit = vi.fn<Mock<(value: ValuePayload) => Promise<string | null>>>();
    await mountEditor(payload("color3f_array", [[0.5, 0.5, 0.5]]), oncommit);
    pressEnter();
    await tick();
    textInput().blur();
    await tick();
    expect(oncommit).not.toHaveBeenCalled();
  });

  it("an edited hex different from the original commits", async () => {
    const oncommit = vi.fn<Mock<(value: ValuePayload) => Promise<string | null>>>().mockResolvedValue(null);
    await mountEditor(payload("color3f_array", [[0.5, 0.5, 0.5]]), oncommit);
    textInput().value = "#ff0000";
    textInput().dispatchEvent(new Event("input", { bubbles: true }));
    pressEnter();
    await tick();
    expect(oncommit).toHaveBeenCalledWith({ type: "color3f_array", data: [[1, 0, 0]] });
  });
});
