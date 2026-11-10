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
// a load) can be set without driving a pose.
const state = vi.hoisted(() => ({ status: "idle", scrubInFlight: false }));

const scene = vi.hoisted(() => ({
  installPlaybackDriver: vi.fn(),
}));

vi.mock("$lib/dev/transportKeepAlive", async () => {
  await dev.gate;
  return { startTransportKeepAlive: dev.startTransportKeepAlive };
});
vi.mock("$lib/dev/mcpBridge.svelte", () => ({ startMcpBridge: dev.startMcpBridge }));
vi.mock("$lib/render/renderState.svelte", () => ({
  renderState: {
    get status() {
      return state.status;
    },
    get isTimeStepInFlight() {
      return state.scrubInFlight;
    },
  },
  snapToTimeCodes: (time: number) => time,
  toAbsoluteTime: (offset: number, start: number) => offset + start,
}));
vi.mock("$lib/render/sceneIntegration", () => ({
  integrateScene: vi.fn(),
  loadRustScene: vi.fn(),
  installPlaybackDriver: scene.installPlaybackDriver,
  refreshSceneAfterEdit: vi.fn(),
  resetLoadedScene: vi.fn(),
  syncGraphicsSettings: vi.fn(),
  syncLightRig: vi.fn(),
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

import Viewport from "./Viewport.svelte";
import type { RendererKit } from "$lib/three/RendererKit.svelte";

function viewer(): RendererKit {
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
    animationProgress: 0,
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
  localStorage.clear();
});

afterEach(async () => {
  if (instance !== null) await unmount(instance);
  instance = null;
  document.body.innerHTML = "";
  vi.unstubAllEnvs();
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
