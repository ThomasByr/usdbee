// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, unmount, tick } from "svelte";
import * as THREE from "three";
import ExportModal from "./ExportModal.svelte";
import ExportModalStackHarness from "./__tests__/export-modal-stack-harness.svelte";
import exportModalSource from "./ExportModal.svelte?raw";

let instance: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  if (instance !== null) unmount(instance);
  instance = null;
});

function exportProps(onClose: () => void) {
  return {
    renderer: null,
    scene: null,
    camera: null,
    hasAnimation: false,
    animationDuration: 0,
    animationProgress: 0,
    previewAt: null,
    isExporting: false,
    exportProgress: 0,
    exportStage: "Exporting...",
    onClose,
    onExport: () => {},
  };
}

function pressEscape(): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

describe("ExportModal shared keyboard ownership", () => {
  it("takes focus on open and closes on Escape from that initial focus", async () => {
    const onClose = vi.fn();
    instance = mount(ExportModal, { target: document.body, props: exportProps(onClose) });
    await tick();

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.contains(document.activeElement)).toBe(true);

    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("unwinds a stacked export modal before the lower shared modal", async () => {
    const onCloseLower = vi.fn();
    const onCloseExport = vi.fn();
    instance = mount(ExportModalStackHarness, {
      target: document.body,
      props: { onCloseLower, onCloseExport },
    });
    await tick();

    pressEscape();
    await tick();
    expect(onCloseExport).toHaveBeenCalledTimes(1);
    expect(onCloseLower).not.toHaveBeenCalled();

    pressEscape();
    await tick();
    expect(onCloseLower).toHaveBeenCalledTimes(1);
  });

  it("renders before reading the preview canvas", async () => {
    // The drawing buffer is not preserved: the preview read must follow a
    // render in the same task or it captures a cleared buffer.
    const log: string[] = [];
    const renderer = {
      domElement: {
        toDataURL: () => {
          log.push("read");
          return "data:image/png;base64,AA==";
        },
      },
      shadowMap: { autoUpdate: false, needsUpdate: false },
      render: () => {
        log.push("render");
      },
      getSize: (target: { set: (x: number, y: number) => void }) => target.set(100, 100),
      setSize: () => {},
      getClearAlpha: () => 1,
      getClearColor: (target: unknown) => target,
      setClearAlpha: () => {},
      setClearColor: () => {},
    };

    instance = mount(ExportModal, {
      target: document.body,
      props: {
        ...exportProps(() => {}),
        renderer: renderer as never,
        scene: new THREE.Scene(),
        camera: new THREE.PerspectiveCamera(),
      },
    });
    // The preview renders on a 50 ms debounce.
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(log.filter((entry) => entry === "read").length).toBeGreaterThan(0);
    log.forEach((entry, i) => {
      if (entry === "read") expect(log[i - 1]).toBe("render");
    });
  });

  it("uses a solid theme-aware preview badge", async () => {
    instance = mount(ExportModal, { target: document.body, props: exportProps(() => {}) });
    await tick();

    const badgeRule = exportModalSource.match(/\.preview-badge\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(badgeRule).toContain("background: var(--accent);");
    expect(badgeRule).toContain("color: var(--accent-contrast);");
    expect(badgeRule).not.toContain("shortcut:");
  });
});
