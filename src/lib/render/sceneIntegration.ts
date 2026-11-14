import * as THREE from "three";
import { loadOrchestrator } from "$lib/state/loadOrchestrator.svelte";
import { stageState } from "$lib/stage/stageState.svelte";
import {
  renderState,
  advanceStageTime,
  getStageLights,
  getStageCameras,
  prefetchPoses,
  snapToTimeCodes,
  snapToPlayableTime,
  toPlayheadOffset,
} from "$lib/render/renderState.svelte";
import {
  holeQueryTime,
  invalidatePoseBuffer,
  isPrefetchDead,
  poseBufferAnchoredAt,
} from "$lib/render/posePrefetch";
import { disposeScene } from "$lib/render/sceneBuilder";
import { clearTextureCache } from "$lib/render/textureCache";
import { isExrPath } from "$lib/render/textureLoaders";
import { upAxisRotation } from "$lib/stage/upAxis";
import * as frameDiag from "$lib/perf/frameDiag";
import { requestShadowUpdate } from "$lib/three/shadowMapUpdate";
import { viewerSettings } from "$lib/state/viewerSettings.svelte";
import type { RendererKit } from "$lib/three/RendererKit.svelte";
import type { LightInfo } from "$lib/stage/types";
import { convertFileSrc } from "@tauri-apps/api/core";

// Renderer-side step functions shared with the page shell: the scene
// pipeline (reset / integrate / load / edit-refresh) and the reactive
// settings-sync bodies. The Viewport owns the calls; the logic here is
// moved verbatim from the pre-extraction page.

// The orange selection box, one helper per selection, replaced wholesale.
// Shared by a hierarchy click and the dev bridge's select_node.
type SelectionTarget = {
  scene: THREE.Scene;
  selectedNode: THREE.Object3D | null;
  selectionHelper: THREE.Box3Helper | null;
};

export function bindSelectionBox(viewer: SelectionTarget, node: THREE.Object3D | null) {
  if (viewer.selectionHelper) {
    viewer.scene.remove(viewer.selectionHelper);
    viewer.selectionHelper.dispose();
    viewer.selectionHelper = null;
  }
  viewer.selectedNode = node;
  if (!node) return;
  // Precise: once per selection, not per frame, and the cached per-geometry
  // box would under-cover a deformed or instanced subtree.
  const box = new THREE.Box3().setFromObject(node, true);
  viewer.selectionHelper = new THREE.Box3Helper(box, new THREE.Color(0xffaa00)); // Orange highlight
  viewer.selectionHelper.visible = !box.isEmpty();
  viewer.scene.add(viewer.selectionHelper);
}

export function resetLoadedScene(viewer: RendererKit) {
  if (viewer.loadedGroup && viewer.scene) {
    viewer.scene.remove(viewer.loadedGroup);
    disposeScene(viewer.loadedGroup);
    viewer.loadedGroup = null;
  }
  // A reset drops the whole scene, so the selection visuals must not
  // outlive it: the helper's box would otherwise freeze over whatever
  // subtree was disposed. A rebuild re-binds both in integrateScene.
  viewer.selectedNode = null;
  if (viewer.selectionHelper) viewer.selectionHelper.visible = false;
  // The only images the memo holds belong to the scene just dropped: a
  // stage closed with no reload after it would keep them for the session.
  clearTextureCache();
  // The timeline bar reads these: left set, it would hang over the empty
  // view after a close and over the next stage for the whole load.
  viewer.hasAnimation = false;
  viewer.animationDuration = 0;
  viewer.animationProgress = 0;
  // The closed stage's light prims go with it: the next load fetches its own.
  viewer.stageLights = [];
  // Same for its cameras: a closed stage must not answer the look-through
  // picker with prims that are gone.
  viewer.stageCameras = [];
}

// Camera fit / grid / light framing for the rust scene (no skinned
// meshes, no USD cameras).
export function integrateScene(viewer: RendererKit, group: THREE.Group) {
  viewer.loadedGroup = group;
  // New geometry in the scene: the shadow map still holds the old casters.
  requestShadowUpdate();
  // A rebuild replaces every node: re-bind the selection to the new subtree
  // or the gizmo and selection box would track a detached node (the old
  // pre-rebind bug where clicking the tree row "fixed" them).
  const selected = stageState.selectedPath;
  viewer.selectedNode = selected ? (group.getObjectByName(selected) ?? null) : null;
  // Stand Z-up stages upright (rotation must land before the fit below).
  group.rotation.x = upAxisRotation(stageState.stageInfo?.up_axis ?? "Y");
  let tris = 0;
  group.traverse((obj) => {
    if ((obj as any).isInstancedMesh) {
      const instanced = obj as THREE.InstancedMesh;
      tris += instanced.count * ((instanced.geometry?.index?.count ?? 0) / 3);
    } else if (obj instanceof THREE.Mesh && obj.geometry?.index) {
      tris += obj.geometry.index.count / 3;
    }
  });
  viewer.triangleCount = Math.floor(tris);
  viewer.usdCameras = [];
  viewer.activeCameraIndex = -1;
  if (viewer.boxHelper) {
    viewer.scene!.remove(viewer.boxHelper);
    viewer.boxHelper.dispose();
  }
  viewer.sceneBox = new THREE.Box3();
  viewer.boxHelper = new THREE.Box3Helper(viewer.sceneBox, new THREE.Color(0xffff00));
  viewer.boxHelper.visible = viewer.showBoundingBox;
  viewer.scene!.add(viewer.boxHelper);

  // Task 6: the rust timeline is driven by stage time codes — the slider
  // and progress readout are 0-based offsets from start_time_code.
  viewer.hasAnimation = renderState.hasAnimated;
  const info = stageState.stageInfo;
  viewer.animationDuration = (info?.end_time_code ?? 0) - (info?.start_time_code ?? 0);
  viewer.animationProgress = toPlayheadOffset(
    renderState.time ?? info?.start_time_code ?? 0,
    info?.start_time_code ?? 0,
  );

  viewer.sceneBox.setFromObject(group, true);
  let size = viewer.sceneBox.getSize(new THREE.Vector3()).length();
  const center = viewer.sceneBox.getCenter(new THREE.Vector3());
  if (size === 0 || !isFinite(size)) size = 10;

  viewer.controls.reset();
  group.position.x -= center.x;
  group.position.y -= center.y;
  group.position.z -= center.z;

  viewer.camera.position.set(size / 2.0, size / 5.0, size);
  viewer.camera.near = Math.max(0.01, size / 100);
  viewer.camera.far = size * 100;
  viewer.camera.updateProjectionMatrix();
  viewer.controls.target.set(0, 0, 0);
  viewer.controls.update();
  viewer.controls.saveState();

  // A bridge-pinned view outlives the reframe: an agent's screenshots stay
  // comparable across rebuilds. Only position and target are pinned; fov is
  // a viewer setting that already survives.
  if (viewer.pinnedCamera) {
    viewer.camera.position.copy(viewer.pinnedCamera.position);
    viewer.controls.target.copy(viewer.pinnedCamera.target);
    viewer.controls.update();
    // Deliberately not saveState: the controls baseline must stay the
    // automatic framing, or controls.reset() (Reset View) restores the pin.
  }

  if (viewer.gridHelper) {
    viewer.scene!.remove(viewer.gridHelper);
    viewer.gridHelper.dispose();
  }
  const gridSize = Math.max(10, Math.pow(10, Math.ceil(Math.log10(size * 2))));
  viewer.gridHelper = new THREE.GridHelper(gridSize, 100, 0x888888, 0x444444);
  viewer.gridHelper.visible = viewer.showGrid;
  viewer.scene!.add(viewer.gridHelper);

  viewer.sceneCenter = center;
  viewer.sceneSize = size;

  if (viewer.dirLight) {
    const d = size * 1.2;
    viewer.dirLight.shadow.camera.left = -d;
    viewer.dirLight.shadow.camera.right = d;
    viewer.dirLight.shadow.camera.top = d;
    viewer.dirLight.shadow.camera.bottom = -d;
    viewer.dirLight.shadow.camera.near = 0.1;
    viewer.dirLight.shadow.camera.far = size * 4;
    viewer.dirLight.shadow.camera.updateProjectionMatrix();
  }

  viewer.scene!.add(group);

  // F4: one light fetch per load, whatever the lighting source: "auto" needs
  // the list to decide, so fetching per mode would only duplicate this site.
  // The builder reacts to the write through the viewport's effect.
  const stageId = stageState.activeStageId;
  if (stageId) {
    void getStageLights(stageId).then((lights) => {
      // A late answer for a stage that is already gone must not relight it.
      if (stageState.activeStageId === stageId) viewer.stageLights = lights;
    });
    // F5: same one-fetch-per-load shape; the look-through picker reads this.
    void getStageCameras(stageId).then((cameras) => {
      if (stageState.activeStageId === stageId) viewer.stageCameras = cameras;
    });
  }
}

export async function loadRustScene(viewer: RendererKit) {
  if (!viewer.scene) return;
  resetLoadedScene(viewer);
  viewer.animationProgress = 0;
  // The backend stream ends at 45 %: the upper half is this build.
  loadOrchestrator.loadingProgress = { stage: "Fetching Scene Manifest", percent: 50 };
  try {
    const group = await renderState.loadRenderScene(
      stageState.stageInfo?.start_time_code ?? 0,
      loadOrchestrator.dependencies ?? {},
      (stage, percent) => (loadOrchestrator.loadingProgress = { stage, percent }),
    );
    if (group) {
      integrateScene(viewer, group);
    } else if (renderState.status === "error") {
      loadOrchestrator.openErrorModal("Error Rendering USD:\n\n" + renderState.error);
    }
  } finally {
    loadOrchestrator.loadingProgress = null;
  }
}

// An edit landed: renderState re-fetches the affected prims' transforms
// and geometry IN PLACE (one manifest + one batched geometry fetch, same
// generation guards as playback). Structural changes (variant swaps
// adding/removing children) still fall back to the full rebuild.
export async function refreshSceneAfterEdit(viewer: RendererKit, paths: string[]) {
  if (!viewer.scene) return;
  let needsRebuild = true;
  try {
    needsRebuild = paths.length > 0 ? await renderState.refreshAfterEdit(paths) : true;
  } catch (e) {
    console.warn("usdbee: edit refresh failed; rebuilding the scene:", e);
  }
  if (!needsRebuild) return;
  resetLoadedScene(viewer);
  const group = await renderState.loadRenderScene(renderState.time ?? 0, loadOrchestrator.dependencies ?? {});
  if (group) integrateScene(viewer, group);
}

export function installPlaybackDriver(viewer: RendererKit) {
  // Task 6 playback driver: the render loop advances the stage playhead
  // in USD time codes. The seconds -> time-code rate conversion lives
  // ONLY here and in the exporter (spec §8) — advanceStageTime.
  //
  // The playhead is CONTINUOUS (unsnapped): advancing from the already-
  // snapped time eats sub-code deltas (60 Hz at 30 tcps advances 0.5
  // codes, then snapping pulls back to the same authored code forever).
  // Only the setStageTime query (and the progress display) snaps.
  let continuous: number | null = null;
  let lastEmitted: number | null = null;
  // The last code reported to frameDiag as PRESENTED. A held code presents
  // nothing, so it must not advance this: the stall then shows up as a real
  // inter-pose gap and the held code as dropped.
  let presented: number | null = null;
  viewer.onAdvanceTime = (deltaSeconds: number) => {
    // Derived state, so it is stamped once per tick before any early return:
    // a tick that bails out (loading, degenerate stage) would otherwise keep
    // whatever the last full tick wrote.
    frameDiag.setPrefetchDead(isPrefetchDead());
    // Main-thread stalls (shader compile, GPU upload) pause the render
    // loop, so THREE.Clock hands us the whole stall as one delta — clamp
    // it or the playhead teleports on the first frame after "ready".
    const delta = Math.min(deltaSeconds, 0.1);
    const info = stageState.stageInfo;
    const start = info?.start_time_code ?? 0;
    const end = info?.end_time_code ?? 0;
    if (end <= start) return;
    // Gate autoplay while a load runs: otherwise the frame the scene
    // centers on depends on how long the load took. User scrubs still
    // queue via setStageTime directly.
    if (renderState.status === "loading") return;
    const tcps = info?.time_codes_per_second ?? 24;
    // Resync: any external write of renderState.time (scrub slider, new
    // load, edit refresh) adopts on the next frame so the continuous
    // playhead never diverges from the stage. A hold is NOT an external
    // write: it leaves renderState.time on the last applied code on purpose,
    // so the playhead keeps running ahead of it and the batch in transit
    // stays valid.
    const held = lastEmitted !== null && renderState.heldTime === lastEmitted;
    const resynced = renderState.time !== lastEmitted && !held;
    if (resynced) {
      // Backwards means the playhead is being rewound onto codes it already
      // presented: the harmful form, and the one a legible diag must count.
      const rewound = continuous !== null && renderState.time !== null && renderState.time < continuous;
      continuous = renderState.time ?? start;
      frameDiag.setRate(tcps);
      frameDiag.onPoseResync(rewound);
      // A scrub, load or edit refresh wrote the playhead: the poses looked
      // ahead from the one we just left no longer follow it — unless the
      // window was claimed from exactly this code (the cold-start seed meeting
      // the first play tick), where it does.
      // The window was kept (the seed meeting its own playhead), so nothing
      // was dropped: counting this as an invalidation would make the diag say
      // the window was thrown away when it was not.
      if (!poseBufferAnchoredAt(renderState.time)) {
        frameDiag.onInvalidate("resync");
        invalidatePoseBuffer();
      }
    }
    // advanceStageTime without codes keeps the advanced value continuous
    // (wrap past end, clamp at start); the query snaps and clamps itself.
    continuous = advanceStageTime(continuous ?? start, delta, tcps, start, end);
    const snapped = snapToPlayableTime(continuous, renderState.timeCodes, start, end);
    // Inside a code hole the query time is the playhead's own time on the tcps
    // grid: hole times are wall-clock floats, so unquantized every frame is a
    // new f64 and neither the batch keys nor the backend pose-frame cache can
    // ever repeat. Grid times present real USD poses; nothing is interpolated.
    const next = Math.min(
      Math.max(
        frameDiag.codeIndex(renderState.timeCodes, snapped) < 0
          ? holeQueryTime(snapped, renderState.timeCodes, tcps)
          : snapped,
        start,
      ),
      end,
    );
    // A forward wrap (playback past the end) drops the playhead back to the
    // start while end-of-loop poses are still buffered. They can never be
    // consumed (the playhead already passed them) but they still count as
    // coverage, so the window would never fall below half and prefetch would
    // stay dormant for the rest of the loop pass. A scrub is not a wrap and
    // is already covered by the resync branch above.
    if (!resynced && lastEmitted !== null && next < lastEmitted) {
      frameDiag.onInvalidate("wrap");
      invalidatePoseBuffer("wrap");
      // Claim the post-wrap window from the wrap target BEFORE the step. The
      // step above it would otherwise find nothing buffered and nothing it may
      // wait for, and single-fetch the very pose a batch could carry. The claim
      // still waits the abandoned end-of-loop batch's remaining wall (the one
      // wait a wrap cannot avoid); adoption only frees the guard, so this claim
      // is issued at all and its stale settle cannot release the new guard.
      // Claimed here, not after the step, because the batch has to be on the
      // wire before the step decides whether to hold.
      if (renderState.status === "ready") void prefetchPoses(next, tcps, true);
    }
    viewer.animationProgress = toPlayheadOffset(next, start);
    lastEmitted = next;
    // Where the playhead sits in the authored code list: a park on one code
    // while frames keep ticking narrows the freeze to the codes themselves.
    // -1 = unauthored (the playhead is inside a hole).
    const codeIdx = frameDiag.codeIndex(renderState.timeCodes, next);
    frameDiag.setCodes(
      renderState.timeCodes.length,
      codeIdx < 0
        ? -1
        : codeIdx + 1 < renderState.timeCodes.length
          ? renderState.timeCodes[codeIdx + 1]! - next
          : 0,
    );
    void renderState.setStageTime(next, true);
    // After the call: a played hold is already recorded by then, and only the
    // diag waits on it.
    if (next !== presented && renderState.heldTime !== next) {
      frameDiag.onPose(performance.now(), codeIdx);
      presented = next;
    }
    // Look ahead while playing: one background batch of the next K authored
    // codes stays in transit for the whole of playback (any consumed pose
    // re-claims). The frame itself is already stepped above, so a cold buffer
    // costs a wait for that batch, never a stall. Only a live scene looks
    // ahead — a failed load has nothing to fill.
    if (renderState.status === "ready") void prefetchPoses(next, tcps);
  };
}

export function syncGraphicsSettings(viewer: RendererKit) {
  const scale = viewerSettings.renderScale;
  const sMapSize = viewerSettings.shadowMapSize;
  const sMapType = viewerSettings.shadowMapType;
  const tMapping = viewerSettings.toneMapping;
  const aniso = viewerSettings.anisotropy;
  const eIntensity = viewerSettings.envMapIntensity;
  const _groupTrigger = viewer.loadedGroup;

  if (viewer.renderer) {
    viewer.renderer.setPixelRatio(window.devicePixelRatio * scale);

    let needsMaterialUpdate = false;

    const newToneMapping =
      tMapping === "ACESFilmic"
        ? THREE.ACESFilmicToneMapping
        : tMapping === "AgX"
          ? (THREE as any).AgXToneMapping
          : tMapping === "Reinhard"
            ? THREE.ReinhardToneMapping
            : THREE.LinearToneMapping;
    if (viewer.renderer.toneMapping !== newToneMapping && newToneMapping !== undefined) {
      viewer.renderer.toneMapping = newToneMapping;
      needsMaterialUpdate = true;
    }

    const newShadowType =
      sMapType === "Basic"
        ? THREE.BasicShadowMap
        : sMapType === "PCF"
          ? THREE.PCFShadowMap
          : sMapType === "VSM"
            ? THREE.VSMShadowMap
            : THREE.PCFSoftShadowMap;
    if (viewer.renderer.shadowMap.type !== newShadowType) {
      viewer.renderer.shadowMap.type = newShadowType;
      needsMaterialUpdate = true;
      // The new type recompiles the depth materials and changes how the
      // map is sampled: draw it again in that mode.
      requestShadowUpdate();
    }

    if (viewer.scene) {
      viewer.scene.traverse((obj: any) => {
        if (obj.isMesh && obj.material) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          mats.forEach((m: any) => {
            let localMaterialUpdate = false;
            if (m.envMapIntensity !== eIntensity) {
              m.envMapIntensity = eIntensity;
              localMaterialUpdate = true;
            }
            const textureKeys = [
              "map",
              "normalMap",
              "roughnessMap",
              "metalnessMap",
              "aoMap",
              "emissiveMap",
              "clearcoatMap",
              "clearcoatNormalMap",
              "transmissionMap",
            ];
            for (const key of textureKeys) {
              if (m[key] && m[key].isTexture && m[key].anisotropy !== aniso) {
                m[key].anisotropy = Math.min(viewer.renderer.capabilities.getMaxAnisotropy(), aniso);

                if (aniso > 1 && m[key].minFilter !== THREE.LinearMipmapLinearFilter) {
                  m[key].minFilter = THREE.LinearMipmapLinearFilter;
                  m[key].generateMipmaps = true;
                }

                m[key].needsUpdate = true;
                localMaterialUpdate = true;
              }
            }

            if (needsMaterialUpdate || localMaterialUpdate) {
              m.needsUpdate = true;
            }
          });
        }
      });
    }
  }

  if (viewer.dirLight && viewer.dirLight.shadow.mapSize.width !== sMapSize) {
    viewer.dirLight.shadow.mapSize.width = sMapSize;
    viewer.dirLight.shadow.mapSize.height = sMapSize;
    if (viewer.dirLight.shadow.map) {
      viewer.dirLight.shadow.map.dispose();
      viewer.dirLight.shadow.map = null as any;
    }
    // A disposed map must be drawn again, or on-demand updates leave the
    // scene with no shadows at all.
    requestShadowUpdate();
  }
}

export function syncLightRig(viewer: RendererKit, lightAzimuth: number, lightElevation: number) {
  // Any rig change moves the light: the casters' shadows all shift.
  requestShadowUpdate();
  applyToneExposure(viewer);
  if (viewer.ambientLight) viewer.ambientLight.intensity = viewerSettings.ambientIntensity;
  if (viewer.dirLight) {
    viewer.dirLight.intensity = viewerSettings.dirIntensity;
    viewer.dirLight.castShadow = viewerSettings.shadowsEnabled;

    const phi = THREE.MathUtils.degToRad(lightAzimuth);
    const theta = THREE.MathUtils.degToRad(90 - lightElevation);

    const radius = viewer.sceneSize * 2.0; // Distance based on viewer.scene scale
    const x = radius * Math.sin(theta) * Math.sin(phi);
    const y = radius * Math.cos(theta);
    const z = radius * Math.sin(theta) * Math.cos(phi);

    viewer.dirLight.position.copy(viewer.sceneCenter).add(new THREE.Vector3(x, y, z));
    viewer.dirLight.target.position.copy(viewer.sceneCenter);
    viewer.dirLight.target.updateMatrixWorld();
  }
}

// ---- F4: stage lights ---------------------------------------------------

export interface SceneLightSettings {
  sceneLightScale: number;
  shadowsEnabled: boolean;
  shadowMapSize: number;
}

// Spec R1: "auto" lights the stage from its own light prims as soon as it has
// one, "scene" never falls back to the rig, "studio" always keeps it.
// "auto" probes ENABLED lights only: an invisible prim emits nothing, so a
// stage whose only light is off falls back to the rig as a user expects.
export function sceneLightsActive(source: string, lights: LightInfo[]): boolean {
  if (source === "studio") return false;
  return source === "scene" || lights.some((light) => light.enabled);
}

// USD exposure is stops; three has no light units at all, so one global scale
// lets the eye calibrate per asset instead of us guessing a constant.
// shortcut: `normalize` (radiance per unit area) folds into that same scale
// rather than being integrated per kind; upgrade if a normalized light reads
// wrong next to an unnormalized one.
function lightIntensity(info: LightInfo, scale: number): number {
  return info.intensity * 2 ** info.exposure * scale;
}

// The scene branch never reaches syncLightRig, so the exposure write lives in
// one helper both lighting sources share: otherwise the slider goes inert and
// the exposure snaps back to the constructor's 1.0.
function applyToneExposure(viewer: RendererKit) {
  if (viewer.renderer) viewer.renderer.toneMappingExposure = viewerSettings.toneExposure;
}

// FALLBACK ONLY: a light whose world transform cannot be read sits on one
// anchor scaled by the scene and aims at the origin, where integrateScene
// re-centers the geometry. Every light that ships a transform is placed there.
function lightAnchor(viewer: RendererKit): THREE.Vector3 {
  return new THREE.Vector3(0.6, 0.9, 0.6).multiplyScalar(viewer.sceneSize);
}

type LightPose = { position: THREE.Vector3; forward: THREE.Vector3 };

// Where a light sits and which way it points, in viewer space. Row-major,
// row-vector convention — the same shape values.rs::world_transform produces —
// so the translation is the last row and row 2 is the local Z axis a USD light
// emits along (its negative Z).
// The stage group is stood upright and only then re-centred by integrateScene,
// so the pose takes the same up-axis rotation first; the scene center it is
// shifted by is already viewport-space (the box is measured after the rotation).
function lightPose(viewer: RendererKit, info: LightInfo): LightPose | null {
  const m = info.world_transform;
  if (!m || m.length !== 16) return null;
  const axis = new THREE.Vector3(1, 0, 0);
  const spin = upAxisRotation(stageState.stageInfo?.up_axis ?? "Y");
  const position = new THREE.Vector3(m[12] ?? 0, m[13] ?? 0, m[14] ?? 0)
    .applyAxisAngle(axis, spin)
    .sub(viewer.sceneCenter);
  const forward = new THREE.Vector3(-(m[8] ?? 0), -(m[9] ?? 0), -(m[10] ?? 0)).applyAxisAngle(axis, spin);
  // A degenerate axis names no direction: fail back to the anchor.
  if (forward.lengthSq() < 1e-12) return null;
  return { position, forward: forward.normalize() };
}

// Drops the dome texture; true when there was one. The environment itself is
// the caller's: scene mode falls back to no environment, the studio path to
// baseEnvironment.
function releaseDome(viewer: RendererKit): boolean {
  if (!viewer.sceneEnv) return false;
  viewer.sceneEnv.dispose();
  viewer.sceneEnv = null;
  viewer.sceneEnvPath = null;
  return true;
}

// Spec R1: in scene mode the environment is the authored dome or nothing. The
// studio RoomEnvironment is fill the stage never authored, so a lightless stage
// then renders with the light it declares: none.
function setSceneEnvironment(viewer: RendererKit, texture: THREE.Texture | null, intensity: number) {
  if (!viewer.scene) return;
  viewer.scene.environment = texture;
  viewer.scene.environmentIntensity = intensity;
}

// A textured dome lights the scene as an equirect environment. The texture is
// kept while the path holds: the rig rebuilds on every slider tick, and a
// re-fetch plus a re-dispose per tick would drop the image for a frame each
// time.
// shortcut: USD's dome color is not baked into the texture; upgrade if a
// fixture authors a tinted dome.
function setDomeEnvironment(viewer: RendererKit, file: string, intensity: number) {
  if (viewer.sceneEnvPath !== file) {
    // A second textured dome must not leak the first one's image.
    releaseDome(viewer);
    const texture = new THREE.TextureLoader().load(convertFileSrc(file), undefined, undefined, () => {
      // Fail-soft: the stage still renders, on the light it authored. A newer
      // dome that already won is left alone.
      if (viewer.sceneEnvPath !== file) return;
      releaseDome(viewer);
      setSceneEnvironment(viewer, null, 1);
      requestShadowUpdate();
    });
    texture.mapping = THREE.EquirectangularReflectionMapping;
    // shortcut: a degenerate equirect (1x1) samples as black in three's
    // environment lookup, so a dome must point at a real 2:1 image or the
    // stage goes dark; upgrade if a guard against tiny maps is ever needed.
    // EXR carries linear float data; an image file is sRGB-encoded.
    texture.colorSpace = isExrPath(file) ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    viewer.sceneEnv = texture;
    viewer.sceneEnvPath = file;
  }
  if (viewer.scene && viewer.sceneEnv) {
    setSceneEnvironment(viewer, viewer.sceneEnv, intensity);
  }
}

function buildSceneLight(
  viewer: RendererKit,
  info: LightInfo,
  settings: SceneLightSettings,
): THREE.Light | null {
  const intensity = lightIntensity(info, settings.sceneLightScale);
  const color = new THREE.Color(info.color[0] ?? 1, info.color[1] ?? 1, info.color[2] ?? 1);

  if (info.kind === "dome") {
    // An untextured dome is one flat fill: its color at its intensity.
    if (!info.texture_file) return new THREE.AmbientLight(color, intensity);
    setDomeEnvironment(viewer, info.texture_file, intensity);
    return null;
  }

  // The light's own place, or the shared anchor when it carries no transform
  // (which then aims at the origin, where the geometry is re-centred).
  const pose = lightPose(viewer, info);
  const position = pose ? pose.position : lightAnchor(viewer);
  const forward = pose ? pose.forward : position.clone().negate().normalize();
  const aim = position.clone().add(forward);
  let light: THREE.Light;

  switch (info.kind) {
    case "distant": {
      const distant = new THREE.DirectionalLight(color, intensity);
      // A distant light's own orientation IS its direction: put it back along
      // its aim so its shadow camera sees the stage in front of it.
      distant.position.copy(position).addScaledVector(forward, -2 * viewer.sceneSize);
      distant.target.position.copy(position);
      distant.target.updateMatrixWorld();
      // shortcut: USD's DistantLight.angle is the emitter's angular diameter
      // (soft-shadow size) and three's DirectionalLight has no equivalent knob,
      // so `angle` stays authored data unused for direction; upgrade if three
      // grows a directional soft-shadow radius.
      light = distant;
      break;
    }
    case "rect": {
      const rect = new THREE.RectAreaLight(color, intensity, info.width ?? 1, info.height ?? 1);
      rect.position.copy(position);
      // three's lookAt points a light's -Z at the target, as USD's does.
      rect.lookAt(aim);
      light = rect;
      break;
    }
    default: {
      // Sphere, disk and cylinder: a point at the source. USD's radius sizes the
      // emitting surface, which three has no per-light knob for, so it becomes a
      // generous falloff cutoff (shortcut: radius 0 keeps the light unbounded).
      const radius = info.radius ?? 0;
      const distance = radius > 0 ? radius * 20 : 0;
      if (info.shaping) {
        const spot = new THREE.SpotLight(
          color,
          intensity,
          distance,
          // three's SpotLight.angle is the half-angle and must stay under a
          // right angle, or the cone edge falls apart.
          Math.min(THREE.MathUtils.degToRad(info.shaping.cone_angle), Math.PI / 2 - 1e-3),
          info.shaping.cone_softness,
        );
        spot.position.copy(position);
        spot.target.position.copy(aim);
        spot.target.updateMatrixWorld();
        light = spot;
      } else {
        // shortcut: three has no axis light, so a cylinder's length and its
        // flat ends are not modeled — it lights as a point.
        const point = new THREE.PointLight(color, intensity, distance);
        point.position.copy(position);
        light = point;
      }
    }
  }

  // three throws shadows from directional, spot and point lights only: a rect
  // area light has no shadow support, so its casts_shadow cannot be honoured.
  const shadow = (light as THREE.DirectionalLight).shadow;
  if (
    settings.shadowsEnabled &&
    info.casts_shadow &&
    shadow &&
    !(light as THREE.RectAreaLight).isRectAreaLight
  ) {
    light.castShadow = true;
    // three's own default is 512; the studio rig sizes its map from the same
    // setting, so both lighting sources stay consistent.
    shadow.mapSize.width = settings.shadowMapSize;
    shadow.mapSize.height = settings.shadowMapSize;
    shadow.bias = -0.0001;
    const reach = viewer.sceneSize * 1.2;
    if ((light as THREE.DirectionalLight).isDirectionalLight) {
      // The default ortho bounds cover 5 units: the stage's own extent decides.
      shadow.camera.left = -reach;
      shadow.camera.right = reach;
      shadow.camera.top = reach;
      shadow.camera.bottom = -reach;
      shadow.camera.far = viewer.sceneSize * 4;
      shadow.camera.updateProjectionMatrix();
    } else if ((light as THREE.PointLight).isPointLight) {
      (light as THREE.PointLight).shadow.camera.far = viewer.sceneSize * 4;
    }
  }

  return light;
}

// Spec R3: scene lights replace the rig entirely. Rebuilds per load and per
// settings change, so the previous build is disposed first.
export function syncSceneLights(viewer: RendererKit, lights: LightInfo[], settings: SceneLightSettings) {
  // The lights go, the dome stays: a scale-slider tick rebuilds the rig and
  // must not re-fetch and re-dispose the environment image.
  releaseSceneLights(viewer);
  // The studio key and fill would double the stage's own light.
  if (viewer.ambientLight) viewer.ambientLight.visible = false;
  if (viewer.dirLight) viewer.dirLight.visible = false;
  applyToneExposure(viewer);

  // A build with no textured dome leaves the stage with no environment: the
  // studio one would light it from a source it never authored.
  const texturedDome = lights.some((info) => info.enabled && info.kind === "dome" && info.texture_file);
  if (!texturedDome) {
    releaseDome(viewer);
    setSceneEnvironment(viewer, null, 1);
  }

  for (const info of lights) {
    // `enabled` is the prim's computed visibility: an invisible light is off.
    if (!info.enabled) continue;
    const light = buildSceneLight(viewer, info, settings);
    if (!light) continue;
    viewer.sceneLights.push(light);
    viewer.scene?.add(light);
  }

  // The frozen shadow map still holds the rig's shadows.
  requestShadowUpdate();
}

// Drops the built scene lights; true when there was one.
function releaseSceneLights(viewer: RendererKit): boolean {
  const had = viewer.sceneLights.length > 0;
  for (const light of viewer.sceneLights) {
    viewer.scene?.remove(light);
    // Light.dispose() frees no shadow render target, and the rig rebuilds on
    // every slider tick: an undisposed one leaks per rebuild. LightShadow's
    // own dispose frees the map and the map pass both; the hand-rolled map
    // dispose leaked the VSM map pass.
    (light as THREE.DirectionalLight).shadow?.dispose();
    light.dispose();
  }
  viewer.sceneLights.length = 0;
  return had;
}

// Shows the studio rig again; true when either light was hidden.
function restoreRig(viewer: RendererKit): boolean {
  let shown = false;
  if (viewer.ambientLight && !viewer.ambientLight.visible) {
    viewer.ambientLight.visible = true;
    shown = true;
  }
  if (viewer.dirLight && !viewer.dirLight.visible) {
    viewer.dirLight.visible = true;
    shown = true;
  }
  return shown;
}

// Back to the studio rig: drop the stage lights, put the studio environment
// back and show the rig again. The rig and environment restores are
// unconditional — scene mode may have left no environment at all, so an early
// return would keep the viewport dark on the studio source.
export function clearSceneLights(viewer: RendererKit) {
  const released = releaseSceneLights(viewer);
  const dome = releaseDome(viewer);
  const rig = restoreRig(viewer);
  setSceneEnvironment(viewer, viewer.baseEnvironment, 1);
  if (released || dome || rig) requestShadowUpdate();
}
