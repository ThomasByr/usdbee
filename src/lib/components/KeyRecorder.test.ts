// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, unmount, tick } from "svelte";

import KeyRecorder from "./KeyRecorder.svelte";

let instance: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (instance !== null) unmount(instance);
  instance = null;
  document.body.innerHTML = "";
});

function mountRecorder(binding: string) {
  const onchange = vi.fn();
  let wire: { binding: string } = { binding };
  instance = mount(KeyRecorder, {
    target: document.body,
    props: {
      get binding() {
        return wire.binding;
      },
      set binding(value: string) {
        wire.binding = value;
      },
      onchange,
    },
  });
  return { onchange, wire };
}

function press(init: KeyboardEventInit & { key: string }) {
  window.dispatchEvent(new KeyboardEvent("keydown", init));
}

async function startRecording() {
  document.querySelector<HTMLButtonElement>(".keybtn")!.click();
  await tick();
}

describe("KeyRecorder", () => {
  it("shows the formatted binding", async () => {
    mountRecorder("mod+p");
    await tick();
    expect(document.querySelector(".keybtn")!.textContent!.trim()).toBe("Ctrl+P");
  });

  it("captures a ctrl combo as mod+<key>", async () => {
    const { onchange, wire } = mountRecorder("z");
    await tick();
    await startRecording();

    press({ key: "p", ctrlKey: true });
    await tick();

    expect(wire.binding).toBe("mod+p");
    expect(onchange).toHaveBeenCalledWith("mod+p");
  });

  it("captures a plain key lowercased, and a lone modifier by name", async () => {
    const { wire } = mountRecorder("z");
    await tick();
    await startRecording();
    press({ key: "K" });
    await tick();
    expect(wire.binding).toBe("k");

    await startRecording();
    press({ key: "Shift" });
    await tick();
    expect(wire.binding).toBe("shift");
  });

  it("cancels on Escape without changing the binding", async () => {
    const { onchange, wire } = mountRecorder("z");
    await tick();
    await startRecording();

    press({ key: "Escape" });
    await tick();

    expect(wire.binding).toBe("z");
    expect(onchange).not.toHaveBeenCalled();
    expect(document.querySelector(".keybtn")!.textContent!.trim()).toBe("Z");
  });
});
