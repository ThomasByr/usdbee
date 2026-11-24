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

function release(init: KeyboardEventInit & { key: string }) {
  window.dispatchEvent(new KeyboardEvent("keyup", init));
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

  it("captures a plain key lowercased", async () => {
    const { wire } = mountRecorder("z");
    await tick();
    await startRecording();
    press({ key: "K" });
    await tick();
    expect(wire.binding).toBe("k");
  });

  it("records a lone modifier on its release, not on its press", async () => {
    const { onchange, wire } = mountRecorder("z");
    await tick();
    await startRecording();

    press({ key: "Shift" });
    await tick();
    expect(onchange).not.toHaveBeenCalled();

    release({ key: "Shift" });
    await tick();
    expect(wire.binding).toBe("shift");
    expect(onchange).toHaveBeenCalledWith("shift");
  });

  it("records a modifier pressed before a chord key", async () => {
    const { onchange, wire } = mountRecorder("z");
    await tick();
    await startRecording();

    press({ key: "Control" });
    await tick();
    press({ key: "p", ctrlKey: true });
    await tick();

    expect(wire.binding).toBe("mod+p");
    expect(onchange).toHaveBeenCalledWith("mod+p");
  });

  it("records ctrl+shift+p as mod+p", async () => {
    const { wire } = mountRecorder("z");
    await tick();
    await startRecording();

    press({ key: "Control" });
    press({ key: "Shift" });
    press({ key: "p", ctrlKey: true, shiftKey: true });
    await tick();

    expect(wire.binding).toBe("mod+p");
  });

  it("keeps recording when a chord cannot be expressed as a binding", async () => {
    const { onchange, wire } = mountRecorder("z");
    await tick();
    await startRecording();

    press({ key: "G", altKey: true });
    await tick();

    expect(wire.binding).toBe("z");
    expect(onchange).not.toHaveBeenCalled();
    expect(document.querySelector(".keybtn")!.textContent!.trim()).toBe("Press keys…");
  });

  it("records ctrl+shift combos, since a mod combo does not look at shift", async () => {
    // matchesBinding has no shift term for "mod+p", so the recorded binding
    // is exactly what Ctrl+Shift+P will fire.
    const { onchange, wire } = mountRecorder("z");
    await tick();
    await startRecording();

    press({ key: "P", ctrlKey: true, shiftKey: true });
    await tick();

    expect(wire.binding).toBe("mod+p");
    expect(onchange).toHaveBeenCalledWith("mod+p");
  });

  it("records shift-held keys, so AZERTY digits are bindable", async () => {
    // Shift+1 is how the "1" key is typed on a French layout.
    const { onchange, wire } = mountRecorder("z");
    await tick();
    await startRecording();

    press({ key: "1", shiftKey: true });
    await tick();

    expect(wire.binding).toBe("1");
    expect(onchange).toHaveBeenCalledWith("1");
  });

  it("records ctrl+shift+tab as mod+shift+tab", async () => {
    // A named key carries shift into the binding: Ctrl+Tab and Ctrl+Shift+Tab
    // are different actions.
    const { wire } = mountRecorder("z");
    await tick();
    await startRecording();

    press({ key: "Control" });
    press({ key: "Shift" });
    press({ key: "Tab", ctrlKey: true, shiftKey: true });
    await tick();

    expect(wire.binding).toBe("mod+shift+tab");
  });

  it("records Ctrl+Shift+Tab when WebKit reports Unidentified", async () => {
    const { wire } = mountRecorder("z");
    await tick();
    await startRecording();

    press({ key: "Unidentified", code: "Tab", ctrlKey: true, shiftKey: true });
    await tick();

    expect(wire.binding).toBe("mod+shift+tab");
  });

  it("records ctrl+pagedown as mod+pagedown", async () => {
    const { wire } = mountRecorder("z");
    await tick();
    await startRecording();

    press({ key: "PageDown", ctrlKey: true });
    await tick();

    expect(wire.binding).toBe("mod+pagedown");
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
