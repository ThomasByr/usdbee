// sceneIntegration tests: the playback driver gate — autoplay must not
// advance the playhead while a scene load is in flight, or the pose the
// scene centers on would depend on how long the load took.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://${path}`,
}));

import * as THREE from "three";
import { invoke } from "@tauri-apps/api/core";
import {
  clearSceneLights,
  installPlaybackDriver,
  integrateScene,
  loadRustScene,
  resetLoadedScene,
  sceneLightsActive,
  syncGraphicsSettings,
  syncLightRig,
  syncSceneLights,
} from "./sceneIntegration";
import type { LightInfo } from "../stage/types";
import { loadCachedTexture } from "./textureCache";
import { renderState, prefetchPoses } from "./renderState.svelte";
import { invalidatePoseBuffer, isPrefetchDead, poseCoverage, takePose } from "./posePrefetch";
import * as frameDiag from "../perf/frameDiag";
import { loadOrchestrator } from "../state/loadOrchestrator.svelte";
import { stageState } from "../stage/stageState.svelte";
import { viewerSettings } from "../state/viewerSettings.svelte";
import { consumeShadowUpdate } from "../three/shadowMapUpdate";
import type { RendererKit } from "../three/RendererKit.svelte";
import { encodePoseBatch, encodePoseFrame, emptyPoseBatch } from "./poseFrameFixture";

const mockedInvoke = vi.mocked(invoke);

function viewer(): RendererKit {
  return { animationProgress: 0 } as unknown as RendererKit;
}

// Minimal kit that integrateScene can drive: camera/controls framing plus
// the helpers it recreates.
function integrateKit(): RendererKit {
  return {
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    controls: {
      target: new THREE.Vector3(),
      reset: vi.fn(),
      update: vi.fn(),
      saveState: vi.fn(),
    },
    gridHelper: null,
    boxHelper: null,
    dirLight: null,
    showGrid: false,
    showBoundingBox: false,
    selectedNode: null,
    animationProgress: 0,
    pinnedCamera: null,
  } as unknown as RendererKit;
}

function namedGroup(path: string): { group: THREE.Group; node: THREE.Object3D } {
  const group = new THREE.Group();
  const node = new THREE.Object3D();
  node.name = path;
  group.add(node);
  return { group, node };
}

beforeEach(() => {
  mockedInvoke.mockReset();
  renderState.time = null;
  renderState.status = "idle";
  renderState.timeCodes = [];
  stageState.selectedPath = null;
  consumeShadowUpdate();
  stageState.stageInfo = {
    start_time_code: 0,
    end_time_code: 24,
    time_codes_per_second: 24,
  } as any;
});

describe("installPlaybackDriver", () => {
  it("does not advance time while the render state is loading", () => {
    renderState.time = 0;
    renderState.status = "loading";
    const v = viewer();
    installPlaybackDriver(v);

    v.onAdvanceTime!(0.5);

    expect(renderState.time).toBe(0);
    expect(v.animationProgress).toBe(0);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("advances normally once the status is ready again", () => {
    renderState.time = 0;
    renderState.status = "ready";
    const v = viewer();
    installPlaybackDriver(v);

    v.onAdvanceTime!(0.05);

    expect(renderState.time).toBeCloseTo(1.2, 10);
    expect(v.animationProgress).toBeCloseTo(1.2, 10);
  });

  it("caps a single huge delta (main-thread stall) at 0.1 s of advance", () => {
    stageState.stageInfo = {
      start_time_code: 0,
      end_time_code: 240,
      time_codes_per_second: 24,
    } as any;
    renderState.time = 0;
    renderState.status = "ready";
    const v = viewer();
    installPlaybackDriver(v);

    // 5 s stall at 24 tcps would be 120 codes unclamped.
    v.onAdvanceTime!(5);

    expect(renderState.time).toBeLessThanOrEqual(0.1 * 24);
  });

  it("still accumulates repeated small deltas normally", () => {
    renderState.time = 0;
    renderState.status = "ready";
    const v = viewer();
    installPlaybackDriver(v);

    for (let i = 0; i < 10; i++) v.onAdvanceTime!(1 / 60);

    expect(renderState.time).toBeCloseTo((10 / 60) * 24, 5);
  });

  it("advances past the first authored code under exact small deltas (stall regression)", () => {
    // Regression: advancing from the ALREADY-SNAPPED time re-snaps to the
    // same authored code every frame — 30 tcps at 60 Hz advances 0.5
    // codes, then snapping eats the sub-code delta, so playback stalls.
    // Real rAF deltas are irregular, which is why this only failed on
    // exact-delta displays.
    renderState.timeCodes = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    stageState.stageInfo = {
      start_time_code: 0,
      end_time_code: 8,
      time_codes_per_second: 30,
    } as any;
    renderState.time = 0;
    renderState.status = "ready";
    const v = viewer();
    installPlaybackDriver(v);

    for (let i = 0; i < 10; i++) v.onAdvanceTime!(1 / 60);

    expect(renderState.time).toBeGreaterThan(1);
  });

  it("records one pose sample per distinct presented code", () => {
    renderState.time = 0;
    renderState.status = "ready";
    const v = viewer();
    installPlaybackDriver(v);
    frameDiag.reset();

    for (let i = 0; i < 10; i++) v.onAdvanceTime!(1 / 60);

    const diag = frameDiag.snapshot();
    // The first tick presents a code, so nine gaps follow it.
    expect(diag.poseN).toBe(9);
    // No authored codes on this fixture: gaps are measurable, drops are not.
    expect(diag.droppedCodes).toBe(0);
    expect(diag.tcps).toBe(24);
  });

  it("counts the authored codes the playhead skipped", () => {
    renderState.timeCodes = Array.from({ length: 25 }, (_, i) => i);
    renderState.time = 0;
    renderState.status = "ready";
    const v = viewer();
    installPlaybackDriver(v);
    frameDiag.reset();

    v.onAdvanceTime!(0); // presents code 0
    v.onAdvanceTime!(2 / 24); // 2 codes later: index 1 never showed

    expect(frameDiag.snapshot().droppedCodes).toBe(1);
  });

  it("does not count a forward scrub as dropped codes", () => {
    renderState.timeCodes = Array.from({ length: 25 }, (_, i) => i);
    renderState.time = 0;
    renderState.status = "ready";
    const v = viewer();
    installPlaybackDriver(v);
    frameDiag.reset();

    v.onAdvanceTime!(0); // presents code 0
    void renderState.setStageTime(10); // simulated scrub
    v.onAdvanceTime!(0); // presents code 10

    expect(frameDiag.snapshot().droppedCodes).toBe(0);
  });

  it("continues from an externally scrubbed time, not a stale playhead", () => {
    // The driver keeps its own continuous playhead; any external write of
    // renderState.time (scrub slider, new load) must be adopted on the
    // very next frame so the two never diverge.
    renderState.time = 0;
    renderState.status = "ready";
    const v = viewer();
    installPlaybackDriver(v);

    v.onAdvanceTime!(1 / 60); // the driver now holds a stale playhead
    void renderState.setStageTime(10); // simulated scrub
    v.onAdvanceTime!(1 / 60);

    expect(renderState.time).toBeGreaterThan(10);
  });
});

// The batch pose response with one empty pose frame per entry: the smallest
// legal payload for the decode.
function poseBatch(count: number): ArrayBuffer {
  const frame = encodePoseFrame([], emptyPoseBatch());
  return encodePoseBatch(Array.from({ length: count }, () => frame));
}

describe("installPlaybackDriver pose prefetch", () => {
  const codes = Array.from({ length: 60 }, (_, i) => i);

  function batchCalls() {
    return mockedInvoke.mock.calls.filter(([cmd]) => cmd === "get_animated_pose_batch");
  }

  // The batch fill lands in microtasks: a macrotask flushes all of them.
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const singlePoseCalls = () => mockedInvoke.mock.calls.filter(([cmd]) => cmd === "get_animated_pose");

  beforeEach(() => {
    invalidatePoseBuffer();
    renderState.timeCodes = codes;
    renderState.time = 0;
    renderState.status = "ready";
    stageState.stageInfo = {
      start_time_code: 0,
      end_time_code: 60,
      time_codes_per_second: 24,
    } as any;
    mockedInvoke.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "get_animated_pose_batch") return poseBatch(args.times.length);
      throw new Error(`unexpected command: ${cmd}`);
    });
  });

  it("issues one batch for the look-ahead instead of one pose per frame", async () => {
    const v = viewer();
    installPlaybackDriver(v);

    v.onAdvanceTime!(1 / 24); // presents code 1
    await flush(); // the batch lands and fills the buffer
    for (let i = 0; i < 5; i++) v.onAdvanceTime!(1 / 24);

    // No frame paid a single-pose invoke, and the top-up stays one batch in
    // flight: claimed once, no second claim while it is pending.
    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === "get_animated_pose")).toHaveLength(0);
    expect(batchCalls()).toHaveLength(2);
    expect(batchCalls()[0]![1]).toEqual({
      stageId: stageState.activeStageId,
      times: codes.slice(2, 2 + 12),
    });
  });

  it("tops up as soon as one pose of the window is consumed", async () => {
    const v = viewer();
    installPlaybackDriver(v);
    v.onAdvanceTime!(1 / 24); // presents code 1: cold look-ahead, one batch
    await flush(); // ...which lands and fills 2..13
    expect(batchCalls()).toHaveLength(1);

    // One pose consumed: the window is one short, so the next frame claims
    // again — the refill margin is no longer shorter than the batch itself,
    // and it asks only for the codes the buffer does not hold.
    takePose(2);
    v.onAdvanceTime!(1 / 24);

    expect(poseCoverage(2)).toBe(11);
    expect(batchCalls()).toHaveLength(2);
    expect(batchCalls()[1]![1]).toEqual({
      stageId: stageState.activeStageId,
      times: codes.slice(14, 14 + 12),
    });

    // The top-up is still in flight: no third claim, however many frames run.
    for (let i = 0; i < 3; i++) v.onAdvanceTime!(1 / 24);
    expect(batchCalls()).toHaveLength(2);
  });

  it("keeps the load's pre-seed through the first play tick", async () => {
    // What the load does: claim the window from the parked playhead.
    await prefetchPoses(0, 24);
    await flush();
    expect(poseCoverage(0)).toBe(12);

    const v = viewer();
    installPlaybackDriver(v);
    mockedInvoke.mockClear();
    v.onAdvanceTime!(1 / 24); // presents code 1 from the seed

    // The first tick resyncs the playhead; that must not drop the seed, or
    // the frame pays a single-pose fetch and the hold deadline bites.
    expect(singlePoseCalls()).toHaveLength(0);
    expect(poseCoverage(1)).toBe(11);
  });

  it("does not count the seed's kept window as an invalidation", async () => {
    await prefetchPoses(0, 24);
    await flush();
    expect(poseCoverage(0)).toBe(12);

    const v = viewer();
    installPlaybackDriver(v);
    frameDiag.reset();
    v.onAdvanceTime!(1 / 24); // resyncs the playhead onto the seed's own code

    // The window was kept, so the counter cannot claim it was dropped: the
    // diag has to tell "thrown away" from "kept" to stay readable.
    const diag = frameDiag.snapshot();
    expect(diag.resyncTotal).toBe(1);
    expect(diag.invalidateResync).toBe(0);
  });

  it("revives the batch path when a failed window's own code is resynced onto", async () => {
    mockedInvoke.mockImplementationOnce(async () => {
      throw new Error("stage busy");
    });
    await prefetchPoses(0, 24); // the load's seed, and it fails
    await flush();
    expect(isPrefetchDead()).toBe(true);

    const v = viewer();
    installPlaybackDriver(v);
    mockedInvoke.mockClear();
    v.onAdvanceTime!(0); // resync onto the failed window's own code

    // The same-code resync is the only cheap epoch bump: if the anchor
    // survives the failure, prefetch stays dead for the session.
    expect(isPrefetchDead()).toBe(false);
    expect(batchCalls()).toHaveLength(1);
  });

  it("still drops a window that was not claimed from the resync target", async () => {
    await prefetchPoses(0, 24);
    await flush();

    const v = viewer();
    installPlaybackDriver(v);
    renderState.time = 30; // an external write: a scrub
    v.onAdvanceTime!(0);

    expect(poseCoverage(30)).toBe(0);
  });

  it("drops the look-ahead when the playhead is written externally", async () => {
    const v = viewer();
    installPlaybackDriver(v);
    v.onAdvanceTime!(1 / 24); // presents code 1
    await flush(); // batch fills 2..13
    expect(poseCoverage(1)).toBe(12);
    expect(batchCalls()).toHaveLength(1);

    renderState.time = 30; // simulated scrub
    v.onAdvanceTime!(0);

    // The pre-scrub window is gone, not merely behind the new playhead: the
    // resync branch drops it before the next batch is even claimed.
    expect(poseCoverage(1)).toBe(0);
    expect(takePose(2)).toBeNull();
    expect(poseCoverage(30)).toBe(0);
    expect(batchCalls()).toHaveLength(2);
    expect(batchCalls()[1]![1]).toEqual({
      stageId: stageState.activeStageId,
      times: codes.slice(31, 31 + 12),
    });
  });

  it("drops the look-ahead on a backwards scrub too", async () => {
    // The resync branch must not care which way the external write went: a
    // rewind leaves the forward window just as unusable as a forward scrub.
    const v = viewer();
    installPlaybackDriver(v);
    renderState.time = 30;
    v.onAdvanceTime!(0); // resyncs to 30 and claims 31..42
    await flush();
    expect(poseCoverage(30)).toBe(12);

    renderState.time = 5; // simulated rewind
    v.onAdvanceTime!(0);

    expect(poseCoverage(30)).toBe(0);
    expect(takePose(31)).toBeNull();
    expect(batchCalls()).toHaveLength(2);
    expect(batchCalls()[1]![1]).toEqual({
      stageId: stageState.activeStageId,
      times: codes.slice(6, 6 + 12),
    });
  });

  it("clears the look-ahead at the loop wrap so prefetch keeps claiming", async () => {
    // Wrapping past the end drops the playhead back to the start while
    // end-of-loop poses are still buffered. They can never be consumed from
    // there but still count as coverage, so with K/2 of them left no batch is
    // ever claimed again and every step pays the single-pose invoke.
    const loop = Array.from({ length: 40 }, (_, i) => i);
    renderState.timeCodes = loop;
    stageState.stageInfo = {
      start_time_code: 0,
      end_time_code: 39,
      time_codes_per_second: 60,
    } as any;
    renderState.time = 33;
    const v = viewer();
    installPlaybackDriver(v);

    v.onAdvanceTime!(0); // presents 33 and claims the clamped tail 34..39
    await flush();
    expect(poseCoverage(33)).toBe(6);

    v.onAdvanceTime!(0.1); // 6 codes: presents 39, skipping the buffered tail
    v.onAdvanceTime!(0.1); // wraps to code 6
    expect(renderState.time).toBe(6);

    expect(poseCoverage(6)).toBe(0);
    expect(batchCalls()).toHaveLength(2);
    // The wrap target is the claim's slot 0: the post-wrap window is claimed
    // from it, before the step, so that frame's own pose is on the wire.
    expect(batchCalls()[1]![1]).toEqual({
      stageId: stageState.activeStageId,
      times: loop.slice(6, 6 + 12),
    });
  });
});

describe("installPlaybackDriver on a held code", () => {
  const codes = Array.from({ length: 60 }, (_, i) => i);
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const singlePoseCalls = () => mockedInvoke.mock.calls.filter(([cmd]) => cmd === "get_animated_pose");

  // The hold needs a loaded group (setStageTime has nothing to hold for
  // without one) and an authored code list; the manifest can stay empty.
  beforeEach(async () => {
    invalidatePoseBuffer();
    renderState.timeCodes = codes;
    stageState.stageInfo = {
      start_time_code: 0,
      end_time_code: 60,
      time_codes_per_second: 24,
    } as any;
    mockedInvoke.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "get_scene_manifest") return [];
      if (cmd === "get_time_codes") return codes;
      if (cmd === "get_animated_pose") return encodePoseFrame([], emptyPoseBatch());
      if (cmd === "get_animated_pose_batch") return poseBatch(args.times.length);
      throw new Error(`unexpected command: ${cmd}`);
    });
    await renderState.loadRenderScene(0);
    // The load pre-seeds the window; these tests drive the hold a cold buffer
    // takes (after a wrap or a scrub), so start from that state.
    invalidatePoseBuffer();
  });

  // Drives playback to a code the window does not hold, with a refill in
  // transit: the hold. Returns the driver and the release of that refill —
  // a test that aborts early must still release it, or the claim stays in
  // flight for the next test.
  async function playIntoHold() {
    let refills = 0;
    let releaseRefill!: () => void;
    const hanging = new Promise<void>((resolve) => (releaseRefill = resolve));
    mockedInvoke.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "get_scene_manifest") return [];
      if (cmd === "get_time_codes") return codes;
      if (cmd === "get_animated_pose") return encodePoseFrame([], emptyPoseBatch());
      if (cmd === "get_animated_pose_batch") {
        if (refills++ > 0) await hanging;
        return poseBatch(args.times.length);
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    const v = viewer();
    installPlaybackDriver(v);
    frameDiag.reset();
    v.onAdvanceTime!(1 / 24); // code 1: one fetch, look-ahead 2..13
    await flush();
    // One frame per code with the step settled in between, as a real rAF
    // gives us: 2..13 come from the window, 14..25 from a refill that hangs.
    for (let code = 2; code <= 13; code++) {
      v.onAdvanceTime!(1 / 24);
      await flush();
    }
    v.onAdvanceTime!(1 / 24); // code 14: a miss, the refill still in transit
    return { v, releaseRefill };
  }

  it("plays through a hold without rewinding or dropping the window", async () => {
    const { v, releaseRefill } = await playIntoHold();
    try {
      expect(renderState.time).toBe(13);
      // The playhead passed the held code instead of rewinding onto it.
      expect(v.animationProgress).toBeCloseTo(14, 10);

      mockedInvoke.mockClear();
      releaseRefill(); // the refill lands into an intact window
      await flush();
      v.onAdvanceTime!(1 / 24); // code 15: served from it
      expect(renderState.time).toBe(15);
      expect(v.animationProgress).toBeCloseTo(15, 10);
      expect(singlePoseCalls()).toHaveLength(0);
    } finally {
      releaseRefill();
      await flush();
    }
  });

  it("records the hold as a pose gap and a skipped code", async () => {
    const { v, releaseRefill } = await playIntoHold();
    try {
      releaseRefill();
      await flush();
      v.onAdvanceTime!(1 / 24); // code 15: the first present after the stall

      const diag = frameDiag.snapshot();
      // The held code never showed, so it counts as skipped.
      expect(diag.droppedCodes).toBe(1);
      // And the stall is in the gap ring: 13 to 15 is one sampled gap.
      expect(diag.poseN).toBe(13);
    } finally {
      releaseRefill();
      await flush();
    }
  });

  it("still resyncs on an external write while a batch is in transit", async () => {
    const v = viewer();
    installPlaybackDriver(v);
    v.onAdvanceTime!(1 / 24); // code 1 and a batch in transit
    await flush();
    expect(poseCoverage(2)).toBe(11);

    renderState.time = 30; // simulated scrub
    v.onAdvanceTime!(0);

    // Adopted, then advanced: the pre-scrub window is gone.
    expect(renderState.time).toBe(30);
    expect(v.animationProgress).toBeCloseTo(30, 10);
    expect(poseCoverage(2)).toBe(0);
  });

  it("counts a resync, and marks the backwards ones as rewinds", () => {
    const v = viewer();
    installPlaybackDriver(v);
    v.onAdvanceTime!(1 / 24); // presents code 1
    frameDiag.reset();

    renderState.time = 30; // forward scrub
    v.onAdvanceTime!(0);
    expect(frameDiag.snapshot().resyncTotal).toBe(1);
    expect(frameDiag.snapshot().rewindTotal).toBe(0);

    // A backwards write re-presents codes the playhead already emitted, which
    // is the form that reads as a freeze: count it apart from a forward jump.
    renderState.time = 5;
    v.onAdvanceTime!(0);
    const diag = frameDiag.snapshot();
    expect(diag.resyncTotal).toBe(2);
    expect(diag.rewindTotal).toBe(1);
    expect(diag.invalidateResync).toBe(2);
    expect(diag.invalidateWrap).toBe(0);
  });

  it("presents through a code hole instead of parking on the code before it", async () => {
    // Sparse keys, as the bike stage has them: 0..3 dense, then a 37-code
    // hole. Nearest snapping holds code 3's pose for the hole's first half,
    // which reads as a ~600 ms freeze followed by a jump to 40.
    const sparse = [0, 1, 2, 3, 40, 41, 42];
    renderState.timeCodes = sparse;
    stageState.stageInfo = {
      start_time_code: 0,
      end_time_code: 42,
      time_codes_per_second: 10,
    } as any;
    renderState.time = 0;
    const v = viewer();
    installPlaybackDriver(v);
    v.onAdvanceTime!(0); // presents 0
    await flush(); // its look-ahead lands: 1..3 and 40..42 buffered

    const presented: number[] = [];
    for (let i = 0; i < 5; i++) {
      v.onAdvanceTime!(0.1); // 10 tcps x 0.1 s = one code per frame
      presented.push(renderState.time!);
      await flush();
    }

    // Every frame reached a new time: past the buffered codes the pose follows
    // the playhead through the hole instead of standing still for 18 codes and
    // then jumping to 40.
    expect(presented).toEqual([1, 2, 3, 4, 5]);
    // Unauthored reads as -1, not as 0 (which means "on the last code").
    expect(frameDiag.snapshot().nextCodeGap).toBe(-1);
  });

  it("quantizes hole times onto the tcps grid", async () => {
    const sparse = [0, 1, 2, 3, 40, 41, 42];
    renderState.timeCodes = sparse;
    stageState.stageInfo = {
      start_time_code: 0,
      end_time_code: 42,
      time_codes_per_second: 10,
    } as any;
    renderState.time = 4.35; // off the grid on purpose
    const v = viewer();
    installPlaybackDriver(v);
    v.onAdvanceTime!(0);
    await flush();

    const presented = [renderState.time!];
    for (let i = 0; i < 3; i++) {
      v.onAdvanceTime!(0.007); // 0.07 codes per frame: under one grid step
      presented.push(renderState.time!);
      await flush();
    }

    // The same input times produce the same f64 keys on every loop pass, so
    // the backend pose-frame cache (keyed by the exact f64) hits from the
    // second pass on. A repeated time is a frame the same pose serves.
    expect(presented).toEqual([4.4, 4.4, 4.5, 4.6]);
    for (const time of presented) expect(Object.is(time, Math.round(time * 10) / 10)).toBe(true);
  });

  it("serves hole frames from the hole batch instead of one fetch per pose", async () => {
    const sparse = [0, 1, 2, 3, 40, 41, 42];
    renderState.timeCodes = sparse;
    stageState.stageInfo = {
      start_time_code: 0,
      end_time_code: 42,
      time_codes_per_second: 10,
    } as any;
    renderState.time = 4.5;
    const v = viewer();
    installPlaybackDriver(v);
    v.onAdvanceTime!(0); // presents 4.5, then claims the hole's grid times
    await flush();

    // The claim stops at the hole's exit code: the authored range is the next
    // claim's business, and mixing the two would span both regimes at once.
    const batch = mockedInvoke.mock.calls.filter(([cmd]) => cmd === "get_animated_pose_batch");
    expect(batch.at(-1)![1]).toEqual({
      stageId: stageState.activeStageId,
      times: [4.6, 4.7, 4.8, 4.9, 5, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7],
    });

    mockedInvoke.mockClear();
    for (let i = 0; i < 3; i++) {
      v.onAdvanceTime!(0.01); // one grid step per frame
      await flush();
    }
    // Nothing on the wire: every hole frame came out of the batch.
    expect(singlePoseCalls()).toHaveLength(0);
    expect(renderState.heldTime).toBeNull();
  });

  it("crosses a hole's exit code once, without overshooting or skipping", async () => {
    const sparse = [0, 1, 2, 3, 40, 41, 42];
    renderState.timeCodes = sparse;
    stageState.stageInfo = {
      start_time_code: 0,
      end_time_code: 42,
      time_codes_per_second: 10,
    } as any;
    renderState.time = 39.5;
    const v = viewer();
    installPlaybackDriver(v);
    v.onAdvanceTime!(0);
    await flush();
    frameDiag.reset();

    const presented = [renderState.time!];
    for (let i = 0; i < 3; i++) {
      v.onAdvanceTime!(0.04); // 0.4 codes per frame
      presented.push(renderState.time!);
      await flush();
    }

    // Monotone across the exit, and the authored code after it is reached:
    // the hole's own regime ends where snapToPlayableTime hands back to the
    // nearest code. A rounded step past 41 that then snapped back onto it
    // would read as a loop wrap and drop the whole window.
    expect(presented).toEqual([39.5, 39.9, 40.3, 41]);
    expect(frameDiag.snapshot().invalidateWrap).toBe(0);
  });

  it("does not park at the stage seam when the keys miss it", () => {
    renderState.timeCodes = [10, 11, 12];
    stageState.stageInfo = {
      start_time_code: 0,
      end_time_code: 42,
      time_codes_per_second: 10,
    } as any;
    const v = viewer();
    installPlaybackDriver(v);

    renderState.time = 1;
    v.onAdvanceTime!(0);
    expect(renderState.time).toBe(1);

    renderState.time = 41;
    v.onAdvanceTime!(0);
    expect(renderState.time).toBe(41);
  });

  it("attributes the loop wrap's invalidation to the wrap, not to a resync", () => {
    const loop = Array.from({ length: 40 }, (_, i) => i);
    renderState.timeCodes = loop;
    stageState.stageInfo = {
      start_time_code: 0,
      end_time_code: 39,
      time_codes_per_second: 60,
    } as any;
    renderState.time = 33;
    const v = viewer();
    installPlaybackDriver(v);
    v.onAdvanceTime!(0); // presents 33
    frameDiag.reset();

    v.onAdvanceTime!(0.1); // presents 39
    v.onAdvanceTime!(0.1); // wraps to 6: the buffer is dropped by the wrap

    const diag = frameDiag.snapshot();
    expect(diag.invalidateWrap).toBe(1);
    expect(diag.invalidateResync).toBe(0);
    expect(diag.rewindTotal).toBe(0);
  });

  it("claims the post-wrap window before stepping instead of single-fetching", async () => {
    // The soak's wrap chain: the wrap drops the end-of-loop window while its
    // batch is still on the wire, and the wrap frame then asks for a code
    // nothing holds. Claiming the post-wrap window from the wrap target
    // BEFORE the step puts that pose at slot 0, so the frame holds for the
    // batch instead of paying a single fetch behind the tail batch's wall.
    const loop = Array.from({ length: 40 }, (_, i) => i);
    renderState.timeCodes = loop;
    stageState.stageInfo = {
      start_time_code: 0,
      end_time_code: 39,
      time_codes_per_second: 60,
    } as any;
    await flush(); // the load's own seed settles first
    let releaseTail!: () => void;
    const tailOnWire = new Promise<void>((resolve) => (releaseTail = resolve));
    let batches = 0;
    mockedInvoke.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "get_scene_manifest") return [];
      if (cmd === "get_time_codes") return loop;
      if (cmd === "get_animated_pose") return encodePoseFrame([], emptyPoseBatch());
      if (cmd === "get_animated_pose_batch") {
        if (batches++ === 0) await tailOnWire; // the tail claim nobody consumes
        return poseBatch(args.times.length);
      }
      throw new Error(`unexpected command: ${cmd}`);
    });
    renderState.time = 33;
    const v = viewer();
    installPlaybackDriver(v);

    v.onAdvanceTime!(0); // presents 33, claims the clamped tail 34..39 — hangs
    await flush();
    mockedInvoke.mockClear();

    v.onAdvanceTime!(0.1); // 39: held on the tail batch
    await flush();
    v.onAdvanceTime!(0.1); // wraps to 6
    await flush();

    // Claimed, not refused behind the hanging tail batch (the adoption), and
    // the wrap target it carries is what the frame waits for.
    const batchesIssued = mockedInvoke.mock.calls.filter(([cmd]) => cmd === "get_animated_pose_batch");
    expect(batchesIssued).toHaveLength(1);
    expect(batchesIssued[0]![1]).toEqual({
      stageId: stageState.activeStageId,
      times: loop.slice(6, 6 + 12),
    });
    expect(singlePoseCalls()).toHaveLength(0);

    // The tail batch lands stale: dropped, window intact.
    releaseTail();
    await flush();
    expect(poseCoverage(6)).toBe(11);

    // And the next code presents straight out of the window.
    v.onAdvanceTime!(1 / 60); // code 7
    expect(renderState.time).toBe(7);
    expect(singlePoseCalls()).toHaveLength(0);
  });
});

describe("resetLoadedScene", () => {
  it("drops the scene and the texture memo so a closed stage holds no images", () => {
    // The memo is cleared again at the next load, but a stage closed with
    // no reload after it would keep the last scene's decoded images.
    const load = vi.fn(() => new THREE.Texture());
    loadCachedTexture("/Textures/texgen_7.png", () => {}, load);

    const group = new THREE.Group();
    const scene = new THREE.Scene();
    scene.add(group);
    const kit = { loadedGroup: group, scene } as unknown as RendererKit;

    resetLoadedScene(kit);

    expect(scene.children).not.toContain(group);
    loadCachedTexture("/Textures/texgen_7.png", () => {}, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("drops the selection visuals with the scene", () => {
    // The frame loop only redraws the box while selectedNode is set: a
    // close would freeze the last-drawn box over the empty view.
    const group = new THREE.Group();
    const scene = new THREE.Scene();
    scene.add(group);
    const helper = { visible: true } as unknown as THREE.Box3Helper;
    const kit = {
      loadedGroup: group,
      scene,
      selectedNode: group,
      selectionHelper: helper,
    } as unknown as RendererKit;

    resetLoadedScene(kit);

    expect(kit.selectedNode).toBeNull();
    expect(helper.visible).toBe(false);
  });

  it("hides the timeline bar so no stale player hangs over the empty view or the next load", () => {
    // The bar renders on viewer.hasAnimation alone: a close (or the reset at
    // the next load-start) left the previous stage's flags set, so the bar
    // stayed on screen doing nothing until the new scene integrated.
    const group = new THREE.Group();
    const scene = new THREE.Scene();
    scene.add(group);
    const kit = {
      loadedGroup: group,
      scene,
      hasAnimation: true,
      animationDuration: 96,
      animationProgress: 42,
    } as unknown as RendererKit;

    resetLoadedScene(kit);

    expect(kit.hasAnimation).toBe(false);
    expect(kit.animationDuration).toBe(0);
    expect(kit.animationProgress).toBe(0);
  });
});

describe("integrateScene", () => {
  it("re-binds the selection to the rebuilt subtree", () => {
    // A rebuild disposes the old group: without the re-bind the selection
    // box and the gizmo keep tracking a detached node until the user
    // clicks the prim's tree row again.
    const kit = integrateKit();
    const old = namedGroup("/Scene/Shape");
    kit.selectedNode = old.node;
    stageState.selectedPath = "/Scene/Shape";

    const rebuilt = namedGroup("/Scene/Shape");
    integrateScene(kit, rebuilt.group);

    expect(kit.selectedNode).toBe(rebuilt.node);
  });

  it("clears the selection when the rebuilt subtree lost the selected path", () => {
    const kit = integrateKit();
    const old = namedGroup("/Scene/Gone");
    kit.selectedNode = old.node;
    stageState.selectedPath = "/Scene/Gone";

    const rebuilt = namedGroup("/Scene/Shape");
    integrateScene(kit, rebuilt.group);

    expect(kit.selectedNode).toBeNull();
  });

  it("reapplies a bridge-pinned view over the automatic framing", () => {
    // An agent's pinned view has to survive the reframe, or its screenshots
    // stop being comparable across rebuilds.
    const kit = integrateKit();
    kit.pinnedCamera = {
      position: new THREE.Vector3(5, 6, 7),
      target: new THREE.Vector3(1, 2, 3),
    };

    integrateScene(kit, namedGroup("/Scene/Shape").group);

    expect(kit.camera.position.toArray()).toEqual([5, 6, 7]);
    expect(kit.controls.target.toArray()).toEqual([1, 2, 3]);
    // Once for the framing, once for the pin it then overwrote.
    expect(kit.controls.update).toHaveBeenCalledTimes(2);
    // The pin must not become the controls baseline: Reset View restores it.
    expect(kit.controls.saveState).toHaveBeenCalledTimes(1);
  });

  it("keeps the field of view across the reframe", () => {
    // fov is a viewer setting, not a framing result: a CLI or bridge fov has
    // to outlast the rebuild the way a pinned view does.
    const kit = integrateKit();
    kit.camera.fov = 40;

    integrateScene(kit, namedGroup("/Scene/Shape").group);

    expect(kit.camera.fov).toBe(40);
  });

  it("requests a shadow redraw for the new geometry", () => {
    // Load, rebuild and stage switch all land here: the map holds the old
    // scene's casters until it is redrawn.
    const kit = integrateKit();
    consumeShadowUpdate();

    integrateScene(kit, namedGroup("/Scene/Shape").group);

    expect(consumeShadowUpdate()).toBe(true);
  });
});

describe("syncLightRig", () => {
  it("requests a shadow redraw when the light rig changes", () => {
    const kit = integrateKit();
    kit.renderer = { toneMappingExposure: 1 } as unknown as RendererKit["renderer"];
    kit.dirLight = new THREE.DirectionalLight();
    kit.sceneCenter = new THREE.Vector3();
    kit.sceneSize = 10;
    consumeShadowUpdate();

    syncLightRig(kit, 45, 45);

    expect(consumeShadowUpdate()).toBe(true);
  });
});

describe("syncGraphicsSettings shadow triggers", () => {
  // Only the two shadow branches matter here: the material walk needs no
  // scene, so the kit stays a plain object.
  function graphicsKit(): RendererKit {
    return {
      renderer: {
        shadowMap: { type: THREE.PCFSoftShadowMap, enabled: true, needsUpdate: false },
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1,
        setPixelRatio: vi.fn(),
        capabilities: { getMaxAnisotropy: () => 16 },
      },
      scene: null,
      dirLight: null,
      loadedGroup: null,
    } as unknown as RendererKit;
  }

  const settings = { size: viewerSettings.shadowMapSize, type: viewerSettings.shadowMapType };
  beforeEach(() => {
    settings.size = viewerSettings.shadowMapSize;
    settings.type = viewerSettings.shadowMapType;
    // syncGraphicsSettings reads the device pixel ratio it applies.
    vi.stubGlobal("window", { devicePixelRatio: 1 });
  });
  afterEach(() => {
    viewerSettings.shadowMapSize = settings.size;
    viewerSettings.shadowMapType = settings.type;
    vi.unstubAllGlobals();
  });

  it("requests a redraw when the shadow map type changes", () => {
    // A new type recompiles the depth materials: without a request the map
    // keeps sampling the old one until some caster moves.
    const kit = graphicsKit();
    viewerSettings.shadowMapType = "VSM";
    consumeShadowUpdate();

    syncGraphicsSettings(kit);

    expect(kit.renderer.shadowMap.type).toBe(THREE.VSMShadowMap);
    expect(consumeShadowUpdate()).toBe(true);
  });

  it("requests a redraw when the shadow map size changes", () => {
    const kit = graphicsKit();
    kit.dirLight = {
      shadow: { mapSize: { width: 512, height: 512 }, map: null },
    } as unknown as THREE.DirectionalLight;
    viewerSettings.shadowMapSize = 4096;
    consumeShadowUpdate();

    syncGraphicsSettings(kit);

    expect(kit.dirLight!.shadow.mapSize.width).toBe(4096);
    expect(consumeShadowUpdate()).toBe(true);
  });

  it("leaves the map alone when neither shadow setting changed", () => {
    const kit = graphicsKit();
    kit.renderer.shadowMap.type = THREE.VSMShadowMap;
    viewerSettings.shadowMapType = "VSM";
    consumeShadowUpdate();

    syncGraphicsSettings(kit);

    expect(consumeShadowUpdate()).toBe(false);
  });
});

// Kit the scene-light builder can drive: the integrateKit fake plus the
// light fields the builder reads (the studio rig it replaces, the bookkeeping
// it owns).
function lightKit(): RendererKit {
  return Object.assign(integrateKit(), {
    sceneSize: 10,
    sceneCenter: new THREE.Vector3(),
    ambientLight: new THREE.AmbientLight(),
    dirLight: new THREE.DirectionalLight(),
    sceneLights: [] as THREE.Light[],
    sceneEnv: null,
    sceneEnvPath: null,
    baseEnvironment: null,
    stageLights: [],
  }) as unknown as RendererKit;
}

const LIGHT_SETTINGS = { sceneLightScale: 1, shadowsEnabled: true, shadowMapSize: 2048 };

// Row-major 4x4 in the USD row-vector convention (translation in the last row),
// the shape values.rs::world_transform produces. `rotationX` is degrees about X.
function transform(position: [number, number, number], rotationX = 0): number[] {
  const c = Math.cos(THREE.MathUtils.degToRad(rotationX));
  const s = Math.sin(THREE.MathUtils.degToRad(rotationX));
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, position[0], position[1], position[2], 1];
}

// three's ImageLoader attaches `load`/`error` listeners and assigns `src`. With
// `fail` the stub fires the error path, which a missing dome file takes.
function stubImageDocument(fail = false) {
  vi.stubGlobal("document", {
    createElementNS: () => {
      let onError: (() => void) | null = null;
      const image: any = {
        addEventListener: (name: string, fn: () => void) => {
          if (name === "error") onError = fn;
        },
        removeEventListener() {},
        setAttribute() {},
        style: {},
      };
      Object.defineProperty(image, "src", {
        set: () => {
          if (fail) queueMicrotask(() => onError?.());
        },
      });
      return image;
    },
  });
}

function stageLight(overrides: Partial<LightInfo>): LightInfo {
  return {
    path: "/Scene/L",
    kind: "sphere",
    intensity: 1,
    exposure: 0,
    color: [1, 1, 1],
    enabled: true,
    normalize: false,
    casts_shadow: false,
    ...overrides,
  } as LightInfo;
}

describe("sceneLightsActive", () => {
  it("keeps the studio rig until a stage light exists (auto)", () => {
    expect(sceneLightsActive("auto", [])).toBe(false);
    expect(sceneLightsActive("auto", [stageLight({})])).toBe(true);
  });

  it("honours the explicit modes", () => {
    // "scene" on a stage with no light authors no light: it renders dark.
    expect(sceneLightsActive("scene", [])).toBe(true);
    expect(sceneLightsActive("studio", [stageLight({})])).toBe(false);
  });
});

describe("syncSceneLights", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("aims the fallback direction by the authored angle, per axis", () => {
    const kit = lightKit();

    // 30 degrees, not the 90 an earlier test used: at 90 both horizontal axes
    // are zero, and at 45 the two are equal, so either would still pass with y
    // and z swapped.
    syncSceneLights(kit, [stageLight({ kind: "distant", angle: 30 })], LIGHT_SETTINGS);

    const [light] = kit.sceneLights;
    const distance = 2 * kit.sceneSize;
    expect(light).toBeInstanceOf(THREE.DirectionalLight);
    expect(light!.position.x).toBeCloseTo(0, 6);
    expect(light!.position.y).toBeCloseTo(0.5 * distance, 6);
    expect(light!.position.z).toBeCloseTo(Math.cos(Math.PI / 6) * distance, 6);
  });

  it("aims a distant light along its transform's forward axis", () => {
    const kit = lightKit();

    // rotateX(-60): the local -Z (forward) is (0, -0.866, -0.5), so the light
    // sits back along its aim at (0, 17.32, 10) and targets the stage center.
    syncSceneLights(
      kit,
      [stageLight({ kind: "distant", angle: 45, world_transform: transform([0, 0, 0], -60) })],
      LIGHT_SETTINGS,
    );

    const [light] = kit.sceneLights;
    expect(light!.position.x).toBeCloseTo(0, 6);
    expect(light!.position.y).toBeCloseTo(17.3205081, 5);
    expect(light!.position.z).toBeCloseTo(10, 5);
  });

  it("places a positional light at its world transform, shifted with the scene center", () => {
    const kit = lightKit();
    // integrateScene re-centers the geometry, so the transform's translation
    // must shift by the same center.
    kit.sceneCenter = new THREE.Vector3(0, 1, 0);

    syncSceneLights(kit, [stageLight({ world_transform: transform([0, 3, 0]) })], LIGHT_SETTINGS);

    expect(kit.sceneLights[0]!.position.toArray()).toEqual([0, 2, 0]);
  });

  it("orients a spot light from its transform's axes", () => {
    const kit = lightKit();

    syncSceneLights(
      kit,
      [
        stageLight({
          world_transform: transform([0, 3, 0], 90),
          shaping: { cone_angle: 45, cone_softness: 0 },
        }),
      ],
      LIGHT_SETTINGS,
    );

    const spot = kit.sceneLights[0] as THREE.SpotLight;
    expect(spot.position.toArray()).toEqual([0, 3, 0]);
    // forward is (0, 1, 0): the target sits one unit along it.
    expect(spot.target.position.x).toBeCloseTo(0, 10);
    expect(spot.target.position.y).toBeCloseTo(4, 10);
    expect(spot.target.position.z).toBeCloseTo(0, 10);
  });

  it("orients a rect light along its transform's forward axis", () => {
    const kit = lightKit();

    syncSceneLights(
      kit,
      [stageLight({ kind: "rect", width: 2, height: 1, world_transform: transform([-3, 2, 0], 90) })],
      LIGHT_SETTINGS,
    );

    const rect = kit.sceneLights[0] as THREE.RectAreaLight;
    expect(rect.position.toArray()).toEqual([-3, 2, 0]);
    // getWorldDirection is the object's +Z; a light emits down its -Z.
    const forward = rect.getWorldDirection(new THREE.Vector3()).negate();
    expect(forward.x).toBeCloseTo(0, 10);
    expect(forward.y).toBeCloseTo(1, 10);
    expect(forward.z).toBeCloseTo(0, 10);
  });

  it("falls back to the anchor for a light with no transform", () => {
    const kit = lightKit();

    syncSceneLights(kit, [stageLight({})], LIGHT_SETTINGS);

    expect(kit.sceneLights[0]!.position.toArray()).toEqual([6, 9, 6]);
  });

  it("writes the tone mapping exposure the scene branch would otherwise leave at 1.0", () => {
    const kit = lightKit();
    kit.renderer = { toneMappingExposure: 1 } as unknown as RendererKit["renderer"];
    const previous = viewerSettings.toneExposure;
    viewerSettings.toneExposure = 2.5;
    try {
      syncSceneLights(kit, [stageLight({})], LIGHT_SETTINGS);

      expect(kit.renderer.toneMappingExposure).toBe(2.5);
    } finally {
      viewerSettings.toneExposure = previous;
    }
  });

  it("sizes a scene light's shadow map from the viewer setting", () => {
    const kit = lightKit();

    syncSceneLights(kit, [stageLight({ kind: "distant", casts_shadow: true })], {
      ...LIGHT_SETTINGS,
      shadowMapSize: 4096,
    });

    const [light] = kit.sceneLights as THREE.DirectionalLight[];
    expect(light!.shadow.mapSize.width).toBe(4096);
    expect(light!.shadow.mapSize.height).toBe(4096);
    expect(light!.shadow.bias).toBeCloseTo(-0.0001, 10);
  });

  it("disposes a removed light's shadow map, which Light.dispose() does not", () => {
    const kit = lightKit();
    syncSceneLights(kit, [stageLight({ casts_shadow: true })], LIGHT_SETTINGS);
    const light = kit.sceneLights[0] as THREE.PointLight;
    const map = { dispose: vi.fn() };
    light.shadow.map = map as unknown as THREE.WebGLRenderTarget;

    syncSceneLights(kit, [], LIGHT_SETTINGS);

    // The rig rebuilds on every slider tick: a leaked target per rebuild.
    expect(map.dispose).toHaveBeenCalled();
  });

  it("scales intensity by the exposure stops and the scene light scale", () => {
    const kit = lightKit();
    // f64 widened from f32, as the backend serializes it.
    syncSceneLights(kit, [stageLight({ intensity: 0.8999999761581421, exposure: 2 })], {
      ...LIGHT_SETTINGS,
      sceneLightScale: 0.5,
    });

    expect(kit.sceneLights[0]!.intensity).toBeCloseTo(0.9 * 4 * 0.5, 5);
  });

  it("carries the authored color", () => {
    const kit = lightKit();

    syncSceneLights(kit, [stageLight({ color: [0.8999999761581421, 0.2, 0.1] })], LIGHT_SETTINGS);

    expect(kit.sceneLights[0]!.color.r).toBeCloseTo(0.9, 5);
    expect(kit.sceneLights[0]!.color.g).toBeCloseTo(0.2, 5);
  });

  it("maps a sphere or disk light to a point light", () => {
    for (const kind of ["sphere", "disk"] as const) {
      const kit = lightKit();

      syncSceneLights(kit, [stageLight({ kind, radius: 0.5 })], LIGHT_SETTINGS);

      expect(kit.sceneLights[0]).toBeInstanceOf(THREE.PointLight);
    }
  });

  it("maps a shaped sphere or disk light to a spot light", () => {
    const kit = lightKit();

    syncSceneLights(kit, [stageLight({ shaping: { cone_angle: 45, cone_softness: 0.5 } })], LIGHT_SETTINGS);

    const light = kit.sceneLights[0] as THREE.SpotLight;
    expect(light).toBeInstanceOf(THREE.SpotLight);
    expect(light.angle).toBeCloseTo(Math.PI / 4, 10);
    expect(light.penumbra).toBeCloseTo(0.5, 10);
  });

  it("maps a rect light to a rect area light with its authored size", () => {
    const kit = lightKit();

    syncSceneLights(
      kit,
      [stageLight({ kind: "rect", width: 4, height: 2, casts_shadow: true })],
      LIGHT_SETTINGS,
    );

    const light = kit.sceneLights[0] as THREE.RectAreaLight;
    expect(light).toBeInstanceOf(THREE.RectAreaLight);
    expect(light.width).toBeCloseTo(4, 5);
    expect(light.height).toBeCloseTo(2, 5);
    // three has no rect-area shadow: casts_shadow cannot be honoured.
    expect(light.castShadow).toBe(false);
  });

  it("maps a cylinder light to a point light", () => {
    const kit = lightKit();

    syncSceneLights(kit, [stageLight({ kind: "cylinder", length: 2, radius: 0.5 })], LIGHT_SETTINGS);

    expect(kit.sceneLights[0]).toBeInstanceOf(THREE.PointLight);
  });

  it("maps a plain dome light to one ambient light with the dome color", () => {
    const kit = lightKit();

    syncSceneLights(kit, [stageLight({ kind: "dome", color: [0.5, 0.6, 0.7] })], LIGHT_SETTINGS);

    const [light] = kit.sceneLights;
    expect(light).toBeInstanceOf(THREE.AmbientLight);
    expect(light!.color.g).toBeCloseTo(0.6, 5);
  });

  it("maps a textured dome light to the scene environment, not a light", () => {
    stubImageDocument();
    const kit = lightKit();

    syncSceneLights(kit, [stageLight({ kind: "dome", texture_file: "/tex/checker.png" })], LIGHT_SETTINGS);

    expect(kit.sceneLights).toHaveLength(0);
    expect((kit.scene.environment as THREE.Texture).mapping).toBe(THREE.EquirectangularReflectionMapping);
  });

  it("reads an image dome as sRGB and an EXR dome as linear", () => {
    stubImageDocument();
    const kit = lightKit();

    syncSceneLights(kit, [stageLight({ kind: "dome", texture_file: "/tex/checker.png" })], LIGHT_SETTINGS);
    expect(kit.sceneEnv!.colorSpace).toBe(THREE.SRGBColorSpace);

    syncSceneLights(kit, [stageLight({ kind: "dome", texture_file: "/tex/sky.exr" })], LIGHT_SETTINGS);
    expect(kit.sceneEnv!.colorSpace).toBe(THREE.NoColorSpace);
  });

  it("keeps the dome texture across a rebuild of the same file", () => {
    stubImageDocument();
    const kit = lightKit();
    syncSceneLights(kit, [stageLight({ kind: "dome", texture_file: "/tex/steady.png" })], LIGHT_SETTINGS);
    const first = kit.sceneEnv!;
    const dispose = vi.spyOn(first, "dispose");

    // A scale-slider tick rebuilds the rig: re-fetching and re-disposing the
    // same file would blank the environment on every tick.
    syncSceneLights(kit, [stageLight({ kind: "dome", texture_file: "/tex/steady.png" })], {
      ...LIGHT_SETTINGS,
      sceneLightScale: 4,
    });

    expect(kit.sceneEnv).toBe(first);
    expect(dispose).not.toHaveBeenCalled();
    expect(kit.scene.environment).toBe(first);
  });

  it("disposes the first dome texture when a second file replaces it", () => {
    stubImageDocument();
    const kit = lightKit();
    syncSceneLights(kit, [stageLight({ kind: "dome", texture_file: "/tex/first.png" })], LIGHT_SETTINGS);
    const first = kit.sceneEnv!;
    const dispose = vi.spyOn(first, "dispose");

    syncSceneLights(kit, [stageLight({ kind: "dome", texture_file: "/tex/second.png" })], LIGHT_SETTINGS);

    expect(dispose).toHaveBeenCalled();
    expect(kit.sceneEnv).not.toBe(first);
  });

  it("gives the environment back when the dome file cannot be read", async () => {
    stubImageDocument(true);
    const kit = lightKit();
    kit.baseEnvironment = new THREE.Texture();

    syncSceneLights(kit, [stageLight({ kind: "dome", texture_file: "/tex/missing.png" })], LIGHT_SETTINGS);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Fail-soft: the stage still renders, on the studio environment.
    expect(kit.sceneEnv).toBeNull();
    expect(kit.scene.environment).toBe(kit.baseEnvironment);
  });

  it("skips a light the stage marks invisible", () => {
    const kit = lightKit();

    syncSceneLights(kit, [stageLight({ enabled: false })], LIGHT_SETTINGS);

    expect(kit.sceneLights).toHaveLength(0);
  });

  it("casts shadows only for a shadow-capable type the light asks for", () => {
    const shadowCapable = [
      stageLight({ path: "/d", kind: "distant", casts_shadow: true }),
      stageLight({ path: "/p", casts_shadow: true }),
      stageLight({
        path: "/s",
        casts_shadow: true,
        shaping: { cone_angle: 30, cone_softness: 0 },
      }),
    ];
    const kit = lightKit();

    syncSceneLights(kit, shadowCapable, LIGHT_SETTINGS);

    expect(kit.sceneLights.map((l) => l.castShadow)).toEqual([true, true, true]);
  });

  it("casts no shadow when the light does not ask for one", () => {
    const kit = lightKit();

    syncSceneLights(kit, [stageLight({ casts_shadow: false })], LIGHT_SETTINGS);

    expect(kit.sceneLights[0]!.castShadow).toBe(false);
  });

  it("casts no shadow when the shadows setting is off", () => {
    const kit = lightKit();

    syncSceneLights(kit, [stageLight({ casts_shadow: true })], {
      ...LIGHT_SETTINGS,
      shadowsEnabled: false,
    });

    expect(kit.sceneLights[0]!.castShadow).toBe(false);
  });

  it("replaces the studio rig and rebuilds in place", () => {
    const kit = lightKit();
    consumeShadowUpdate();

    syncSceneLights(kit, [stageLight({})], LIGHT_SETTINGS);

    expect(kit.ambientLight!.visible).toBe(false);
    expect(kit.dirLight!.visible).toBe(false);
    expect(consumeShadowUpdate()).toBe(true);

    // Second run (a settings change): the old light goes, no duplicate stays.
    syncSceneLights(kit, [stageLight({ intensity: 2 })], LIGHT_SETTINGS);

    expect(kit.sceneLights).toHaveLength(1);
    expect(kit.scene.children).toHaveLength(1);
  });

  it("restores the studio rig when the scene lights are cleared", () => {
    const kit = lightKit();
    syncSceneLights(kit, [stageLight({})], LIGHT_SETTINGS);

    clearSceneLights(kit);

    expect(kit.sceneLights).toHaveLength(0);
    expect(kit.scene.children).toHaveLength(0);
    expect(kit.ambientLight!.visible).toBe(true);
    expect(kit.dirLight!.visible).toBe(true);
  });

  it("restores the studio rig after a lightless stage in scene mode", () => {
    // The regression: "scene" on a stage with no light authors no light and
    // hides the rig on purpose. Clearing returned early (nothing to dispose)
    // and left the viewport permanently black back in auto or studio.
    const kit = lightKit();
    syncSceneLights(kit, [], LIGHT_SETTINGS);
    expect(kit.ambientLight!.visible).toBe(false);
    expect(kit.dirLight!.visible).toBe(false);

    clearSceneLights(kit);

    expect(kit.ambientLight!.visible).toBe(true);
    expect(kit.dirLight!.visible).toBe(true);
  });

  it("restores the environment and the rig after a textured dome (scene -> studio)", () => {
    stubImageDocument();
    const kit = lightKit();
    kit.baseEnvironment = new THREE.Texture();
    syncSceneLights(kit, [stageLight({ kind: "dome", texture_file: "/tex/leave.png" })], LIGHT_SETTINGS);
    const env = kit.sceneEnv!;
    const dispose = vi.spyOn(env, "dispose");
    expect(kit.scene.environment).toBe(env);

    clearSceneLights(kit);

    expect(dispose).toHaveBeenCalled();
    expect(kit.sceneEnv).toBeNull();
    expect(kit.scene.environment).toBe(kit.baseEnvironment);
    expect(kit.scene.environmentIntensity).toBe(1);
    expect(kit.ambientLight!.visible).toBe(true);
    expect(kit.dirLight!.visible).toBe(true);
  });

  it("leaves the rig untouched when there is nothing to clear", () => {
    // Auto with no lights: byte-identical to the studio rig.
    const kit = lightKit();
    consumeShadowUpdate();

    clearSceneLights(kit);

    expect(kit.ambientLight!.visible).toBe(true);
    expect(kit.dirLight!.visible).toBe(true);
    expect(consumeShadowUpdate()).toBe(false);
  });
});

describe("loadRustScene progress", () => {
  it("holds the bar at the frontend half and forwards the build's own progress", async () => {
    // The Rust stream ends at 45 %; everything the user waits on after it
    // (manifest, batches, assembly) is reported from here.
    const seen: { stage: string; percent: number }[] = [];
    const spy = vi
      .spyOn(renderState, "loadRenderScene")
      .mockImplementation(async (_start, _fallbacks, onProgress) => {
        seen.push({ ...loadOrchestrator.loadingProgress! });
        onProgress?.("Loading Geometry 32/70", 66);
        seen.push({ ...loadOrchestrator.loadingProgress! });
        return null;
      });

    const kit = { scene: new THREE.Scene(), animationProgress: 0 } as unknown as RendererKit;
    await loadRustScene(kit);

    expect(seen).toEqual([
      { stage: "Fetching Scene Manifest", percent: 50 },
      { stage: "Loading Geometry 32/70", percent: 66 },
    ]);
    expect(loadOrchestrator.loadingProgress).toBeNull();
    spy.mockRestore();
  });
});
