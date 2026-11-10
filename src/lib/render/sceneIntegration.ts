import * as THREE from "three";
import { loadOrchestrator } from "$lib/state/loadOrchestrator.svelte";
import { stageState } from "$lib/stage/stageState.svelte";
import {
  renderState,
  advanceStageTime,
  prefetchPoses,
  snapToTimeCodes,
  toPlayheadOffset,
} from "$lib/render/renderState.svelte";
import { invalidatePoseBuffer, isPrefetchDead } from "$lib/render/posePrefetch";
import { disposeScene } from "$lib/render/sceneBuilder";
import { clearTextureCache } from "$lib/render/textureCache";
import { upAxisRotation } from "$lib/stage/upAxis";
import * as frameDiag from "$lib/perf/frameDiag";
import { requestShadowUpdate } from "$lib/three/shadowMapUpdate";
import { viewerSettings } from "$lib/state/viewerSettings.svelte";
import type { RendererKit } from "$lib/three/RendererKit.svelte";

// Renderer-side step functions shared with the page shell: the scene
// pipeline (reset / integrate / load / edit-refresh) and the reactive
// settings-sync bodies. The Viewport owns the calls; the logic here is
// moved verbatim from the pre-extraction page.

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
      // ahead from the one we just left no longer follow it.
      frameDiag.onInvalidate("resync");
      invalidatePoseBuffer();
    }
    // advanceStageTime without codes keeps the advanced value continuous
    // (wrap past end, clamp at start); the query snaps and clamps itself.
    continuous = advanceStageTime(continuous ?? start, delta, tcps, start, end);
    const next = Math.min(Math.max(snapToTimeCodes(continuous, renderState.timeCodes), start), end);
    // A forward wrap (playback past the end) drops the playhead back to the
    // start while end-of-loop poses are still buffered. They can never be
    // consumed (the playhead already passed them) but they still count as
    // coverage, so the window would never fall below half and prefetch would
    // stay dormant for the rest of the loop pass. A scrub is not a wrap and
    // is already covered by the resync branch above.
    if (!resynced && lastEmitted !== null && next < lastEmitted) {
      frameDiag.onInvalidate("wrap");
      invalidatePoseBuffer();
    }
    viewer.animationProgress = toPlayheadOffset(next, start);
    lastEmitted = next;
    // Where the playhead sits in the authored code list: a park on one code
    // while frames keep ticking narrows the freeze to the codes themselves.
    const codeIdx = frameDiag.codeIndex(renderState.timeCodes, next);
    frameDiag.setCodes(
      renderState.timeCodes.length,
      codeIdx >= 0 && codeIdx + 1 < renderState.timeCodes.length
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
    if (renderState.status === "ready") void prefetchPoses(next);
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
  if (viewer.renderer) viewer.renderer.toneMappingExposure = viewerSettings.toneExposure;
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
