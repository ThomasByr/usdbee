// @vitest-environment happy-dom
// The dev keep-alive call site: the module's own gates are pinned in
// transportKeepAlive.test.ts, this pins the wiring the viewport does — the DEV
// gate around the dynamic import, the idle predicate it hands over, and the
// teardown when the component goes away before that import resolves.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import type { KeepAliveOptions } from "$lib/dev/transportKeepAlive";

const dev = vi.hoisted(() => ({
  startTransportKeepAlive: vi.fn((_options: KeepAliveOptions) => () => {}),
  startMcpBridge: vi.fn(() => () => {}),
  // Held open to model the window where a component tears down before its
  // dynamic import resolves; a resolved gate is the ordinary case.
  gate: Promise.resolve() as Promise<void>,
  open: (() => {}) as () => void,
}));

// The idle predicate reads live render state; a mutable stub stands in for it
// so the states the real module would be in (a scrub's pose step on the wire,
// a load) can be set without driving a pose. `time` is a reactive SvelteMap so
// the viewport's effects re-run on a write, exactly like the real $state store.
const state = vi.hoisted(() => ({
  status: "idle",
  scrubInFlight: false,
  times: null as null | {
    get(key: string): number | null | undefined;
    set(key: string, value: number | null): void;
  },
  setTime(time: number | null) {
    state.times?.set("time", time);
  },
}));

const scene = vi.hoisted(() => ({
  installPlaybackDriver: vi.fn(),
}));

vi.mock("$lib/dev/transportKeepAlive", async () => {
  await dev.gate;
  return { startTransportKeepAlive: dev.startTransportKeepAlive };
});
vi.mock("$lib/dev/mcpBridge.svelte", () => ({ startMcpBridge: dev.startMcpBridge }));
vi.mock("$lib/render/renderState.svelte", async () => {
  const { SvelteMap } = await import("svelte/reactivity");
  state.times = new SvelteMap<string, number | null>([[`time`, null]]);
  return {
    renderState: {
      get status() {
        return state.status;
      },
      get isTimeStepInFlight() {
        return state.scrubInFlight;
      },
      get time() {
        return state.times!.get("time") ?? null;
      },
    },
    snapToTimeCodes: (time: number) => time,
    toAbsoluteTime: (offset: number, start: number) => offset + start,
    toPlayheadOffset: (time: number, start: number) => time - start,
  };
});
vi.mock("$lib/render/sceneIntegration", () => ({
  integrateScene: vi.fn(),
  loadRustScene: vi.fn(),
  installPlaybackDriver: scene.installPlaybackDriver,
  refreshSceneAfterEdit: vi.fn(),
  resetLoadedScene: vi.fn(),
  syncGraphicsSettings: vi.fn(),
  syncLightRig: vi.fn(),
  syncSceneLights: vi.fn(),
  clearSceneLights: vi.fn(),
  sceneLightsActive: vi.fn(() => false),
}));
vi.mock("$lib/render/gizmoCommit.svelte", () => ({
  disposeGizmo: vi.fn(),
  gateCommitStageRefresh: () => false,
  getGizmoError: () => null,
  getGizmoGate: () => ({ message: null, attachable: false }),
  initGizmo: vi.fn(),
}));
vi.mock("$lib/state/loadOrchestrator.svelte", () => ({
  loadOrchestrator: {
    rootFile: null,
    loadingProgress: null,
    init: () => Promise.resolve(() => {}),
  },
}));
vi.mock("$lib/state/tabsState.svelte", () => ({
  tabsState: { init: () => Promise.resolve(() => {}) },
}));
vi.mock("$lib/state/editState.svelte", () => ({
  editState: { canUndo: false, canRedo: false },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("$lib/commands/launch", () => ({ consumeLaunchOptions: vi.fn(async () => {}) }));

import Viewport from "./Viewport.svelte";
import { SvelteMap } from "svelte/reactivity";
import type { RendererKit } from "$lib/three/RendererKit.svelte";

// A reactive mirror of the kit's $state fields the template reads: a plain
// object would swallow the writes the effects make, which is exactly what the
// dim bar looked like.
function viewer(): RendererKit {
  const progress = new SvelteMap<string, number>([[`value`, 0]]);
  return {
    init: vi.fn(),
    scene: null,
    gridHelper: null,
    boxHelper: null,
    loadedGroup: null,
    controls: null,
    camera: null,
    fov: 0,
    triangleCount: 0,
    animationDuration: 0,
    get animationProgress() {
      return progress.get("value")!;
    },
    set animationProgress(value: number) {
      progress.set("value", value);
    },
    isPlayingAnim: false,
    hasAnimation: false,
    dispose: vi.fn(),
  } as unknown as RendererKit;
}

let instance: ReturnType<typeof mount> | null = null;
// The dynamic imports resolve in microtasks the first time a module is loaded:
// a macrotask flushes them all.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  dev.startTransportKeepAlive.mockClear();
  dev.startMcpBridge.mockClear();
  dev.gate = Promise.resolve();
  scene.installPlaybackDriver.mockClear();
  state.status = "idle";
  state.scrubInFlight = false;
  state.setTime(null);
  localStorage.clear();
});

afterEach(async () => {
  if (instance !== null) await unmount(instance);
  instance = null;
  document.body.innerHTML = "";
  vi.unstubAllEnvs();
});

describe("timeline bar", () => {
  it("follows a stage time written without a driver tick", async () => {
    // The palette, CLI and dev-bridge set_time write the stage time directly:
    // no driver tick follows, so the bar's own mirror has to move with it.
    const kit = viewer();
    kit.hasAnimation = true;
    kit.animationDuration = 100;
    instance = mount(Viewport, {
      target: document.body,
      props: { viewer: kit, lightAzimuth: 0, lightElevation: 0, gizmoMode: "translate" },
    });
    await tick();
    const slider = () => document.querySelector<HTMLInputElement>(".timeline-slider")!;
    const readout = () => document.querySelector(".timeline-time")!.textContent ?? "";
    expect(slider().value).toBe("0");

    state.setTime(40);
    flushSync();

    expect(slider().value).toBe("40");
    expect(readout()).toContain("40");
  });
});

describe("dev keep-alive wiring", () => {
  it("hands the module an idle predicate that excludes a scrub in flight", async () => {
    instance = mount(Viewport, {
      target: document.body,
      props: { viewer: viewer(), lightAzimuth: 0, lightElevation: 0, gizmoMode: "translate" },
    });
    await tick();
    await flush();

    expect(dev.startTransportKeepAlive).toHaveBeenCalledTimes(1);
    const isIdle = dev.startTransportKeepAlive.mock.calls[0]![0]!.isIdle;
    expect(isIdle()).toBe(true);

    // A paused scrub invokes between drag steps: the transport is not quiet,
    // so a ping there only queues behind the pose the user asked for.
    state.scrubInFlight = true;
    expect(isIdle()).toBe(false);
    state.scrubInFlight = false;

    state.status = "loading";
    expect(isIdle()).toBe(false);
  });

  it("arms nothing when the viewport unmounts before the import resolves", async () => {
    // A fresh module registry, so the factory below runs again and its gate
    // holds the import open: the teardown happens while it is still pending.
    vi.resetModules();
    dev.gate = new Promise<void>((resolve) => (dev.open = resolve));

    instance = mount(Viewport, {
      target: document.body,
      props: { viewer: viewer(), lightAzimuth: 0, lightElevation: 0, gizmoMode: "translate" },
    });
    flushSync(); // runs onMount without yielding to the import's microtasks
    expect(scene.installPlaybackDriver).toHaveBeenCalledTimes(1);

    // Gone before the import landed: the interval would arm with nothing left
    // to stop it, one invoke a second for the rest of the dev session.
    await unmount(instance);
    instance = null;
    dev.open();
    await flush();

    expect(dev.startTransportKeepAlive).not.toHaveBeenCalled();
  });

  it("arms nothing outside a dev build", async () => {
    vi.stubEnv("DEV", false);
    instance = mount(Viewport, {
      target: document.body,
      props: { viewer: viewer(), lightAzimuth: 0, lightElevation: 0, gizmoMode: "translate" },
    });
    await tick();
    await flush();

    expect(dev.startTransportKeepAlive).not.toHaveBeenCalled();
    expect(dev.startMcpBridge).not.toHaveBeenCalled();
  });
});
