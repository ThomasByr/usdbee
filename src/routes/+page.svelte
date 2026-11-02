<script lang="ts">
  import "./page.css";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { onMount } from "svelte";
  import { formatKeyName } from "$lib/utils/format";
  import ErrorModal from "$lib/components/ErrorModal.svelte";
  import DependenciesTab from "$lib/components/DependenciesTab.svelte";
  import PrimTree from "$lib/components/stage/PrimTree.svelte";
  import PropertyInspector from "$lib/components/stage/PropertyInspector.svelte";
  import RenderingTab from "$lib/components/RenderingTab.svelte";
  import SettingsTab from "$lib/components/SettingsTab.svelte";
  import LayerTextEditor from "$lib/components/LayerTextEditor.svelte";
  import ExportModal from "$lib/components/ExportModal.svelte";
  import SaveDialog from "$lib/components/SaveDialog.svelte";
  import { runExport } from "$lib/three/VideoExporter";
  import {
    viewerSettings,
    loadGraphicsPreferences,
    saveGraphicsPreferences,
  } from "$lib/state/viewerSettings.svelte";
  import {
    controlsState,
    loadControlPreferences,
    saveControlPreferences,
  } from "$lib/state/controlsState.svelte";
  import { stageState } from "$lib/stage/stageState.svelte";
  import { editState } from "$lib/state/editState.svelte";
  import { confirmCloseNeeded } from "$lib/state/closeGuard";
  import {
    advanceStageTime,
    renderState,
    toAbsoluteTime,
    toPlayheadOffset,
  } from "$lib/render/renderState.svelte";
  import { disposeScene } from "$lib/render/sceneBuilder";
  import { TransformGizmo, type GizmoCommit } from "$lib/render/transformGizmo";
  import { composeOpUpdate, evaluateGizmoGate, matricesClose, type GizmoMode } from "$lib/render/xformOps";
  import type { StageInfo } from "$lib/stage/types";
  import { stageModalErrorLines } from "$lib/stage/modalErrors";
  import { upAxisRotation } from "$lib/stage/upAxis";
  import * as THREE from "three";
  import { RendererKit } from "$lib/three/RendererKit.svelte";

  // State
  let rootFile = $state<string | null>(null);
  let loadingProgress = $state<{ stage: string; percent: number } | null>(null);
  let dependencies = $state<Record<
    string,
    {
      path: string;
      resolved: boolean;
      size_bytes: number | null;
      fallback_color?: string | null;
      error_msg?: string | null;
    }
  > | null>(null);

  let canvas: HTMLCanvasElement;

  let viewer = new RendererKit();
  let activeTab = $state<"files" | "scene" | "rendering" | "settings" | "layers">("files");

  // Rendering Controls
  let hasShownWindow = false;

  // Light Positioning State
  let lightAzimuth = $state<number>(45); // Degrees (-180 to 180)
  let lightElevation = $state<number>(45); // Degrees (0 to 90)

  let showFovSlider = $state<boolean>(false);

  // Transform gizmo (Phase 3 Task 4): attached to a scene-root proxy at the
  // selected prim's world transform; commits author through Task 1's
  // set_attribute_value and the usd-stage-changed refresh re-anchors it.
  let gizmo = $state<TransformGizmo | null>(null);
  let gizmoMode = $state<GizmoMode>("translate");
  let gizmoError = $state<string | null>(null);

  // Hierarchy Tree State
  let expandedNodes = $state<Record<string, boolean>>({});
  let visibilityMap = $state<Record<string, boolean>>({});
  let colorUpdateMap = $state<Record<string, number>>({});
  let selectedNodeId = $state<string | null>(null);

  // Sidebar resize state
  let sidebarWidth = $state<number>(320);
  let isResizing = $state<boolean>(false);
  let filterText = $state<string>("");
  let modalError = $state<string | null>(null);
  let stageModalLines = $state<string[] | null>(null);
  let stageModalDismissed = $state<boolean>(false);
  let showExportModal = $state<boolean>(false);
  let showSaveModal = $state<boolean>(false);
  // Task 5: the OS close request is intercepted while any layer carries
  // unsaved edits; the modal's confirm is the only path that destroys the
  // window.
  let showCloseConfirm = $state<boolean>(false);
  let isExporting = $state<boolean>(false);
  let exportProgress = $state<number>(0);
  let exportStage = $state<string>("Exporting...");

  // Keybindings State

  let omniverseUrl = $state<string>("http://localhost:34080");

  async function updateOmniverseUrl() {
    try {
      await invoke("set_omniverse_url", { url: omniverseUrl });
    } catch (e) {
      console.error("Failed to save Omniverse URL:", e);
    }
  }

  function openErrorModal(msg: string) {
    modalError = msg;
  }

  function closeErrorModal() {
    modalError = null;
  }

  function closeStageModal() {
    stageModalDismissed = true;
  }

  // Review fix (playhead units): the UI layer — timeline slider, progress
  // display, ExportModal range inputs — works in 0..(end-start) offsets.
  // These two helpers are the ONLY boundary back to the absolute USD time
  // codes that setStageTime speaks, applied wherever the UI steps the
  // stage (slider, playback, preview, export frames).
  function startTimeCode(): number {
    return stageState.stageInfo?.start_time_code ?? 0;
  }

  async function handleExport(detail: any) {
    if (detail instanceof CustomEvent) detail = detail.detail;
    console.log("handleExport called with", detail);

    isExporting = true;
    exportProgress = 0;
    exportStage = "Exporting...";

    await runExport(
      {
        renderer: viewer.renderer,
        scene: viewer.scene!,
        camera: viewer.camera,
        animationDuration: viewer.animationDuration,
        animationProgress: viewer.animationProgress,
        // Task 6: the exporter steps USD time codes — the rate is
        // time_codes_per_second and each frame re-fetches animated geometry
        // through setStageTime.
        playbackRate: stageState.stageInfo?.time_codes_per_second ?? 24,
        onBeforeFrame: (t: number) => renderState.setStageTime(toAbsoluteTime(t, startTimeCode())),
      },
      detail,
      {
        onProgress: (stage, percent) => {
          exportStage = stage;
          exportProgress = percent;
          if (
            stage.includes("Video") ||
            stage.includes("Frames") ||
            stage.includes("Encoding") ||
            stage.includes("Saving")
          ) {
            loadingProgress = { stage, percent };
          }
        },
        onComplete: () => {
          showExportModal = false;
          isExporting = false;
          loadingProgress = null;
        },
        onError: (msg) => {
          openErrorModal(msg);
          isExporting = false;
          loadingProgress = null;
        },
      },
    );
  }

  let filteredDependencies = $derived(
    dependencies
      ? Object.entries(dependencies).filter(([path, _]) =>
          path.toLowerCase().includes(filterText.toLowerCase()),
        )
      : [],
  );

  // Stage errors own their modal state (stageModalLines/stageModalDismissed) so
  // they never read or overwrite modalError — rendering errors (usd-load-error,
  // Three.js catch, export, dependency errors) keep exclusive ownership of it.
  let prevStageLines: string[] | null = null;
  $effect(() => {
    const stageLines = stageModalErrorLines({
      status: stageState.status,
      error: stageState.error,
      compositionErrors: stageState.stageInfo?.composition_errors ?? [],
    });
    const changed = JSON.stringify(prevStageLines) !== JSON.stringify(stageLines);
    prevStageLines = stageLines;
    stageModalLines = stageLines;
    if (changed && stageLines) stageModalDismissed = false;
  });

  $effect(() => {
    if (viewer.scene) viewer.scene.background = new THREE.Color(viewer.backgroundColor);
  });

  // --- Transform gizmo (Phase 3, Task 4) -------------------------------

  // The gate logic is pure code in xformOps.ts (Vitest-pinned): a prim
  // with no authored xformOpOrder reports identity transforms and stays
  // editable, so the create-op path can author the op AND xformOpOrder
  // from scratch; only genuinely unsupported stacks disable the gizmo.
  const gizmoGate = $derived(evaluateGizmoGate(stageState.selectedPath, stageState.details));

  const gizmoMessage = $derived(gizmoError ?? gizmoGate.message);

  // The prim's world matrix in VIEWPORT space: the USD world transform
  // composed with the loaded group's recentering + up-axis transform.
  function gizmoWorldMatrix(): THREE.Matrix4 | null {
    const details = stageState.details;
    if (!details?.world_transform) return null;
    const world = new THREE.Matrix4().fromArray(details.world_transform);
    const group = viewer.loadedGroup;
    if (group) {
      group.updateMatrixWorld();
      world.premultiply(group.matrixWorld);
    }
    return world;
  }

  // Commit errors clear with the next selection; a fresh anchor snaps the
  // proxy back to stage truth (also the failure path: a refused commit
  // leaves details unchanged, so the re-anchor undoes the drag).
  $effect(() => {
    const _path = stageState.details?.path;
    gizmoError = null;
  });

  $effect(() => {
    const kit = gizmo;
    const gate = gizmoGate;
    if (!kit) return;
    kit.controls.setMode(gizmoMode);
    if (!gate.attachable) {
      kit.detach();
      return;
    }
    const world = gizmoWorldMatrix();
    if (world) kit.attach(world);
  });

  // Drag end -> desired USD local matrix -> the op(s) to author. The
  // parent/world chain cancels in the start/end ratio, so no ancestor
  // walk is needed: L' = L * inv(startWorld) * endWorld.
  async function handleGizmoCommit(commit: GizmoCommit) {
    const details = stageState.details;
    if (!details?.local_transform || !details.world_transform) return;
    const local = new THREE.Matrix4().fromArray(details.local_transform);
    const target = local
      .clone()
      .multiply(commit.startWorld.clone().invert())
      .multiply(commit.endWorld)
      .toArray() as number[];
    if (matricesClose(target, details.local_transform)) {
      gizmo?.attach(gizmoWorldMatrix() ?? commit.endWorld);
      return;
    }
    const orderAttribute = details.attributes.find((a) => a.name === "xformOpOrder");
    const order = Array.isArray(orderAttribute?.value.data) ? (orderAttribute!.value.data as string[]) : [];
    const result = composeOpUpdate({
      mode: gizmoMode,
      order,
      attrs: details.attributes,
      localMatrix: details.local_transform,
      targetLocalMatrix: target,
    });
    if (!result.ok) {
      gizmoError = result.error;
      gizmo?.attach(gizmoWorldMatrix() ?? commit.endWorld);
      return;
    }
    let failed = false;
    for (const write of result.writes) {
      // xformOpOrder is uniform: it authors its default, never a time
      // sample; the op values author at the viewer's current time code.
      const error = await stageState.setAttributeValue(
        write.name,
        { type: write.type, data: write.data },
        write.name === "xformOpOrder" ? null : undefined,
      );
      if (error !== null) {
        gizmoError = error;
        failed = true;
        break;
      }
    }
    // A successful commit anchors at the drag's end pose until the
    // usd-stage-changed refresh re-anchors from fresh details — the stale
    // details would snap the proxy back between commit and refresh (and a
    // second drag in that window would compute L' from a stale L). A
    // failed commit leaves details unchanged, so re-anchoring from them
    // undoes the drag.
    gizmo?.attach(failed ? (gizmoWorldMatrix() ?? commit.endWorld) : commit.endWorld);
  }

  $effect(() => {
    viewer.showExportModal = showExportModal;
  });

  $effect(() => {
    if (viewer.gridHelper) viewer.gridHelper.visible = viewer.showGrid;
  });

  $effect(() => {
    if (viewer.boxHelper) viewer.boxHelper.visible = viewer.showBoundingBox;
  });

  $effect(() => {
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
    }
  });

  $effect(() => {
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
  });

  $effect(() => {
    if (viewer.loadedGroup) {
      viewer.loadedGroup.traverse((obj: any) => {
        if (obj.isMesh && obj.material) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          mats.forEach((m: any) => (m.wireframe = viewer.showWireframe));
        }
      });
    }
  });

  $effect(() => {
    const mLeft = controlsState.mouseButtonLeft;
    const mMiddle = controlsState.mouseButtonMiddle;
    const mRight = controlsState.mouseButtonRight;
    const speed = controlsState.rotSpeedFactor;

    if (viewer.controls) {
      const MOUSE_MAPPING: Record<string, number> = {
        rotate: THREE.MOUSE.ROTATE,
        pan: THREE.MOUSE.PAN,
        zoom: THREE.MOUSE.DOLLY,
      };
      viewer.controls.rotateSpeed = speed;
      viewer.controls.mouseButtons = {
        LEFT: MOUSE_MAPPING[mLeft] || THREE.MOUSE.ROTATE,
        MIDDLE: MOUSE_MAPPING[mMiddle] || THREE.MOUSE.DOLLY,
        RIGHT: MOUSE_MAPPING[mRight] || THREE.MOUSE.PAN,
      };
    }
  });

  $effect(() => {
    if (viewer.camera && viewer.fov) {
      if (viewer.camera.fov !== viewer.fov) {
        viewer.camera.fov = viewer.fov;
        viewer.camera.updateProjectionMatrix();
      }
    }
  });

  onMount(() => {
    const savedFov = localStorage.getItem("cameraFov");
    if (savedFov) {
      viewer.fov = parseFloat(savedFov);
    }

    const savedDamping = localStorage.getItem("cameraDamping");
    if (savedDamping !== null) {
      viewer.enableDamping = savedDamping === "true";
    }

    // Open the confirm-per-save dialog: only its confirm button ever writes
    // USD content to disk. The dialog refreshes the dirty-layer list on open.
    async function openSaveDialog() {
      if (!stageState.stageInfo) return;
      showSaveModal = true;
      await editState.refresh();
    }

    // Global keyboard shortcuts
    const handleGlobalKeydown = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA")
        return;
      viewer.keysPressed.add(e.key.toLowerCase());
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        openUsdFile();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void openSaveDialog();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "e") {
        e.preventDefault();
        showExportModal = true;
      }
      // Task 5: undo/redo. Ctrl+Z undoes; Ctrl+Shift+Z / Ctrl+Y redoes.
      // The INPUT/TEXTAREA guard above keeps text-field edits intact.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        void editState.undo();
      }
      if (
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z") ||
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y")
      ) {
        e.preventDefault();
        void editState.redo();
      }
    };
    const handleGlobalKeyup = (e: KeyboardEvent) => {
      viewer.keysPressed.delete(e.key.toLowerCase());
    };
    window.addEventListener("keydown", handleGlobalKeydown);
    window.addEventListener("keyup", handleGlobalKeyup);

    // Initialize backend config
    invoke<string>("get_omniverse_url")
      .then((url) => {
        if (url) omniverseUrl = url;
      })
      .catch(console.warn);

    loadControlPreferences();
    loadGraphicsPreferences();
    const savedWidth = localStorage.getItem("sidebarWidth");
    if (savedWidth) {
      let parsed = parseInt(savedWidth);
      if (!isNaN(parsed) && parsed >= 150) {
        sidebarWidth = parsed;
      }
    }

    renderState.onTimeChange = () => {
      void stageState.refreshSelectedDetails();
    };

    // Listeners for Rust events
    const unlisteners = [
      listen("open-export-modal", () => {
        console.log("RECEIVED open-export-modal from Rust!");
        showExportModal = true;
      }),
      listen("open-save-dialog", () => {
        void openSaveDialog();
      }),
      listen<string>("usd-load-error", (event) => {
        loadingProgress = null;
        openErrorModal("Failed to extract or load USD: " + event.payload);
      }),
      listen<string>("usd-load-start", (event) => {
        rootFile = event.payload;
        loadingProgress = { stage: "Starting...", percent: 0 };
        dependencies = null;

        removeLoadedGroup();
      }),
      listen<{ stage: string; percent: number }>("usd-load-progress", (event) => {
        loadingProgress = event.payload;
      }),
      listen<StageInfo>("usd-stage-opened", (event) => {
        stageState.adoptOpenedStage(event.payload);
        // Re-query the edit target + dirty layers: the previous stage's
        // dirty set must not survive into the new open.
        void editState.refresh();
      }),
      listen("usd-scene-loaded", (event: any) => {
        void handleSceneLoaded(event.payload);
      }),
      listen("usd-stage-changed", (event) => {
        const paths = ((event.payload as { paths?: string[] } | null)?.paths ?? []) as string[];
        void stageState.refreshAfterEdit();
        void refreshSceneAfterEdit(paths);
      }),
    ];

    // Editing state: subscribes to usd-stage-changed (dirty-layer and
    // undo-state refresh) and primes the edit-target/dirty-layer snapshot.
    unlisteners.push(editState.init());

    // Task 5: intercept the OS close request while any layer has unsaved
    // edits — the confirm modal's button is the only thing that destroys
    // the window then. The need-to-confirm logic itself is pure code in
    // closeGuard.ts (Vitest-pinned).
    unlisteners.push(
      getCurrentWindow().onCloseRequested((event) => {
        if (confirmCloseNeeded(editState.dirtyLayers.length)) {
          event.preventDefault();
          showCloseConfirm = true;
        }
      }),
    );

    // The viewport scene load: compose the scene from the Rust manifest
    // (no zip, no Three.js USD parsing).
    async function handleSceneLoaded(payload: any) {
      loadingProgress = null;
      rootFile = payload.root_file;
      dependencies = payload.dependencies;
      await loadRustScene();
    }

    if (canvas) {
      viewer.init(canvas);
      // The gizmo lives with the renderer kit's camera/scene/orbit: drag
      // events come off the same canvas, and the orbit disables while a
      // gizmo drag is active. The editing POLICY (gating, anchor, commit
      // math) stays here in the page.
      gizmo = new TransformGizmo(viewer.camera, viewer.renderer.domElement, viewer.scene, viewer.controls);
      gizmo.onCommit = handleGizmoCommit;
    }

    // Task 6 playback driver: the render loop advances the stage playhead
    // in USD time codes. The seconds -> time-code rate conversion lives
    // ONLY here and in the exporter (spec §8) — advanceStageTime.
    viewer.onAdvanceTime = (deltaSeconds: number) => {
      const info = stageState.stageInfo;
      const start = info?.start_time_code ?? 0;
      const end = info?.end_time_code ?? 0;
      if (end <= start) return;
      const tcps = info?.time_codes_per_second ?? 24;
      const next = advanceStageTime(renderState.time ?? start, deltaSeconds, tcps, start, end);
      viewer.animationProgress = toPlayheadOffset(next, start);
      void renderState.setStageTime(next);
    };

    // Cleanup listeners
    return () => {
      window.removeEventListener("keydown", handleGlobalKeydown);
      window.removeEventListener("keyup", handleGlobalKeyup);
      unlisteners.forEach((u) => u.then((f) => f()));
      renderState.onTimeChange = null;
      gizmo?.dispose();
      gizmo = null;
      viewer.dispose();
    };
  });

  function removeLoadedGroup() {
    if (viewer.loadedGroup && viewer.scene) {
      viewer.scene.remove(viewer.loadedGroup);
      disposeScene(viewer.loadedGroup);
      viewer.loadedGroup = null;
    }
  }

  // Camera fit / grid / light framing for the rust scene (no skinned
  // meshes, no USD cameras).
  function integrateScene(group: THREE.Group) {
    viewer.loadedGroup = group;
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

  async function loadRustScene() {
    if (!viewer.scene) return;
    removeLoadedGroup();
    viewer.animationProgress = 0;
    loadingProgress = { stage: "Composing Rust render scene...", percent: 40 };
    try {
      const group = await renderState.loadRenderScene(
        stageState.stageInfo?.start_time_code ?? 0,
        dependencies ?? {},
      );
      if (group) {
        integrateScene(group);
      } else if (renderState.status === "error") {
        openErrorModal("Error Rendering USD:\n\n" + renderState.error);
      }
    } finally {
      loadingProgress = null;
    }
  }

  // An edit landed: renderState re-fetches the affected prims' transforms
  // and geometry IN PLACE (one manifest + one batched geometry fetch, same
  // generation guards as playback). Structural changes (variant swaps
  // adding/removing children) still fall back to the full rebuild.
  async function refreshSceneAfterEdit(paths: string[]) {
    if (!viewer.scene) return;
    let needsRebuild = true;
    try {
      needsRebuild = paths.length > 0 ? await renderState.refreshAfterEdit(paths) : true;
    } catch (e) {
      console.warn("usdbee: edit refresh failed; rebuilding the scene:", e);
    }
    if (!needsRebuild) return;
    removeLoadedGroup();
    const group = await renderState.loadRenderScene(renderState.time ?? 0, dependencies ?? {});
    if (group) integrateScene(group);
  }

  async function openUsdFile() {
    await invoke("trigger_open_usd_dialog");
  }

  async function replaceWithColor(path: string, event: Event) {
    if (!dependencies) return;
    const input = event.target as HTMLInputElement;
    const color = input.value;
    try {
      await invoke("set_fallback_color", { path, color });

      // Update local state to reflect the change
      dependencies[path] = {
        ...dependencies[path],
        resolved: true,
        fallback_color: color,
      };

      if (viewer.loadedGroup) {
        const threeColor = new THREE.Color(color);
        const searchName = path.split(/[\\/]/).pop()?.split(".")[0]?.toLowerCase() || "";

        viewer.loadedGroup.traverse((child: any) => {
          if (child.isMesh && child.material) {
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            for (const mat of mats) {
              if (!mat.map || (mat.name && mat.name.toLowerCase().includes(searchName))) {
                mat.color = threeColor;
                mat.needsUpdate = true;
              }
            }
          }
        });
      }
    } catch (e) {
      console.error("Failed to set fallback color", e);
    }
  }

  // Sidebar drag logic
  function startResize(e: MouseEvent) {
    isResizing = true;
    document.body.style.cursor = "col-resize";

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isResizing) return;
      const maxAllowed = window.innerWidth > 0 ? window.innerWidth - 100 : 3000;
      let newWidth = moveEvent.clientX;
      if (newWidth < 150) newWidth = 150;
      if (newWidth > maxAllowed) newWidth = maxAllowed;
      sidebarWidth = newWidth;
    };

    const onMouseUp = () => {
      isResizing = false;
      document.body.style.cursor = "";
      localStorage.setItem("sidebarWidth", sidebarWidth.toString());
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      // Trigger resize for Three.js
      window.dispatchEvent(new Event("resize"));
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  // Format bytes conditionally
  function traverseWithLockCheck(node: any, callback: (n: any) => void) {
    if (node.userData.locked) return;
    callback(node);
    if (node.children) {
      for (let i = 0; i < node.children.length; i++) {
        traverseWithLockCheck(node.children[i], callback);
      }
    }
  }

  function getCurrentNodeColorHex(node: any): string {
    if (node.userData.branchColorHex) {
      return node.userData.branchColorHex;
    }
    if (node.isMesh && node.material) {
      let mat = Array.isArray(node.material) ? node.material[0] : node.material;
      if (mat && mat.color) {
        return "#" + mat.color.getHexString();
      }
    }
    if (node.children) {
      for (let i = 0; i < node.children.length; i++) {
        if (node.children[i].isMesh && node.children[i].material) {
          let mat = Array.isArray(node.children[i].material)
            ? node.children[i].material[0]
            : node.children[i].material;
          if (mat && mat.color) {
            return "#" + mat.color.getHexString();
          }
        }
      }
    }
    return "#dedede";
  }

  function applyBranchColor(node: any, hexColor: string) {
    if (!node) return;

    const color = new THREE.Color(hexColor);

    const applyColorToNode = (n: any) => {
      n.userData.branchColorHex = hexColor;
      colorUpdateMap[n.uuid] = (colorUpdateMap[n.uuid] || 0) + 1;

      if (n.isMesh && n.material) {
        let mats = Array.isArray(n.material) ? n.material : [n.material];
        if (!n.userData.originalMaterials) {
          n.userData.originalMaterials = mats.map((m: any) => m.clone());
        }
        const newMats = n.userData.originalMaterials.map((m: any) => {
          let newMat = m.clone();
          newMat.color = color;
          return newMat;
        });
        n.material = newMats.length === 1 ? newMats[0] : newMats;
      }
    };

    applyColorToNode(node);
    if (node.children) {
      for (let i = 0; i < node.children.length; i++) {
        traverseWithLockCheck(node.children[i], applyColorToNode);
      }
    }
  }

  function resetBranchColor(node: any) {
    if (!node) return;

    const resetColorOnNode = (n: any) => {
      delete n.userData.branchColorHex;
      colorUpdateMap[n.uuid] = (colorUpdateMap[n.uuid] || 0) + 1;

      if (n.isMesh && n.userData.originalMaterials) {
        n.material =
          n.userData.originalMaterials.length === 1
            ? n.userData.originalMaterials[0]
            : n.userData.originalMaterials;
        delete n.userData.originalMaterials;
      }
    };
    resetColorOnNode(node);
    if (node.children) {
      for (let i = 0; i < node.children.length; i++) {
        traverseWithLockCheck(node.children[i], resetColorOnNode);
      }
    }
  }

  // Rust-path objects are named by their exact prim path.
  function highlightPrimObject(path: string) {
    if (!viewer.loadedGroup || !viewer.scene || !path) return;
    let found: THREE.Object3D | null = null;
    viewer.loadedGroup.traverse((o) => {
      if (!found && o.name === path) found = o;
    });
    if (found) updateSelection(found);
  }

  function toggleBranchLock(node: any, locked: boolean) {
    if (!node) return;
    node.userData.locked = locked;
    colorUpdateMap[node.uuid] = (colorUpdateMap[node.uuid] || 0) + 1;
    viewer.selectedNode = viewer.selectedNode;
  }

  function updateSelection(node: any) {
    if (!viewer.scene) return;

    // Toggle off if already selected
    if (node && selectedNodeId === node.uuid) {
      selectedNodeId = null;
      viewer.selectedNode = null;
      if (viewer.selectionHelper) {
        viewer.scene.remove(viewer.selectionHelper);
        viewer.selectionHelper.dispose();
        viewer.selectionHelper = null;
      }
      return;
    }

    selectedNodeId = node ? node.uuid : null;
    viewer.selectedNode = node ? node : null;

    // Remove previous selection helper
    if (viewer.selectionHelper) {
      viewer.scene.remove(viewer.selectionHelper);
      viewer.selectionHelper.dispose();
      viewer.selectionHelper = null;
    }

    if (node) {
      const box = new THREE.Box3();
      box.setFromObject(node, true);
      viewer.selectionHelper = new THREE.Box3Helper(box, new THREE.Color(0xffaa00)); // Orange highlight
      viewer.scene.add(viewer.selectionHelper);
    }
  }

  // Expand / Collapse All
  function toggleAllExpanded(expand: boolean) {
    if (!viewer.loadedGroup) return;
    const applyExpand = (node: any) => {
      expandedNodes[node.uuid] = expand;
      if (node.children) {
        for (let i = 0; i < node.children.length; i++) {
          applyExpand(node.children[i]);
        }
      }
    };
    applyExpand(viewer.loadedGroup);
  }

  function toggleVisibility(node: any) {
    if (!node) return;
    const targetVisible = (visibilityMap[node.uuid] ?? node.visible) ? false : true;

    const applyVisToNode = (n: any) => {
      n.visible = targetVisible;
      visibilityMap[n.uuid] = targetVisible;
    };

    applyVisToNode(node);
    if (node.children) {
      for (let i = 0; i < node.children.length; i++) {
        traverseWithLockCheck(node.children[i], applyVisToNode);
      }
    }
  }
</script>

<main class="app-layout" class:resizing={isResizing}>
  {#snippet treeNode(node: any, depth: number = 0)}
    <div class="tree-node">
      <div
        class="tree-node-label {selectedNodeId === node.uuid ? 'selected' : ''}"
        style="padding-left: {depth * 15}px;"
        onclick={(e) => {
          e.stopPropagation();
          updateSelection(node);
        }}
        onkeydown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.stopPropagation();
            updateSelection(node);
          }
        }}
        role="button"
        tabindex="0"
      >
        {#if node.children && node.children.length > 0}
          <!-- Expand/collapse chevron -->
          <button
            class="toggle-btn expand-btn"
            onclick={(e) => {
              e.stopPropagation();
              expandedNodes[node.uuid] = !expandedNodes[node.uuid];
            }}
          >
            {expandedNodes[node.uuid] ? "▼" : "▶"}
          </button>
        {/if}
        <span class="node-type">[{node.type}]</span>
        <span class="node-name" title={node.name}>{node.name || "Unnamed"}</span>

        <!-- Spacer to push eye button to the right -->
        <div style="flex: 1;"></div>

        <!-- Branch color tools -->
        <div style="display: flex; gap: 4px; align-items: center; margin-right: 6px;">
          <input
            type="color"
            value={(() => {
              let _ = colorUpdateMap[node.uuid];
              return getCurrentNodeColorHex(node);
            })()}
            oninput={(e) => {
              e.stopPropagation();
              applyBranchColor(node, e.currentTarget.value);
            }}
            onclick={(e) => e.stopPropagation()}
            style="width: 14px; height: 14px; padding: 0; border: none; background: transparent; cursor: pointer;"
            title="Set Branch Color"
          />
          <button
            class="tree-action-btn"
            style="font-size: 11px;"
            onclick={(e) => {
              e.stopPropagation();
              resetBranchColor(node);
            }}
            title="Reset Branch Color">Reset</button
          >
          <button
            class="tree-action-btn {(() => {
              let _ = colorUpdateMap[node.uuid];
              return node.userData.locked ? 'active-lock' : '';
            })()}"
            style="font-size: 11px;"
            onclick={(e) => {
              e.stopPropagation();
              toggleBranchLock(node, !node.userData.locked);
            }}
            title="Lock Branch (Ignore parent color)"
            >{(() => {
              let _ = colorUpdateMap[node.uuid];
              return node.userData.locked ? "🔒 Locked" : "🔓 Lock";
            })()}</button
          >
        </div>

        <!-- Visibility toggle -->
        <button
          class="tree-action-btn {(visibilityMap[node.uuid] ?? node.visible) ? 'active-vis' : 'inactive-vis'}"
          style="font-size: 11px; min-width: 24px;"
          onclick={(e) => {
            e.stopPropagation();
            toggleVisibility(node);
          }}
          title="Toggle Visibility"
        >
          {(visibilityMap[node.uuid] ?? node.visible) ? "👁" : "👁‍🗨"}
        </button>
      </div>
      {#if node.children && node.children.length > 0 && expandedNodes[node.uuid]}
        <div class="tree-node-children">
          {#each node.children as child}
            {@render treeNode(child, depth + 1)}
          {/each}
        </div>
      {/if}
    </div>
  {/snippet}

  <!-- Sidebar for Dependency Tree -->
  <aside class="sidebar" style="width: {sidebarWidth}px;">
    <div class="sidebar-header">
      <h2>
        USDA / Asset Graph
        {#if editState.dirtyLayers.length > 0}
          <span
            class="dirty-dot"
            title="{editState.dirtyLayers.length} layer(s) with unsaved changes — Ctrl+S to save"
          ></span>
        {/if}
      </h2>
      <div class="header-actions">
        <button class="primary-btn" onclick={openUsdFile} title="Open USD File">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
          Open
        </button>
        <button
          class="primary-btn"
          onclick={() => (showExportModal = true)}
          disabled={loadingProgress !== null || rootFile === null}
          title="Export Scene"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
          Export
        </button>
      </div>
    </div>

    <div class="tab-bar">
      <button class="tab-btn" class:active={activeTab === "files"} onclick={() => (activeTab = "files")}
        >Files</button
      >
      <button class="tab-btn" class:active={activeTab === "scene"} onclick={() => (activeTab = "scene")}
        >Hierarchy</button
      >
      <button
        class="tab-btn"
        class:active={activeTab === "rendering"}
        onclick={() => (activeTab = "rendering")}>Rendering</button
      >
      <button class="tab-btn" class:active={activeTab === "layers"} onclick={() => (activeTab = "layers")}
        >Layer Text</button
      >
      <button class="tab-btn" class:active={activeTab === "settings"} onclick={() => (activeTab = "settings")}
        >Settings</button
      >
    </div>

    {#if loadingProgress}
      <div class="progress-box">
        <p>{loadingProgress.stage}</p>
        <div class="progress-bar">
          <div class="progress-fill" style="width: {loadingProgress.percent}%"></div>
        </div>
      </div>
    {/if}

    <div class="dependency-tree">
      {#if activeTab === "files"}
        <DependenciesTab
          {rootFile}
          {dependencies}
          {filteredDependencies}
          bind:filterText
          {openErrorModal}
          {replaceWithColor}
        />
      {/if}
      {#if activeTab === "scene"}
        <div class="scene-split">
          <div class="scene-tree-wrap">
            <PrimTree onHighlight={(node) => highlightPrimObject(node.path)} />
          </div>
          <PropertyInspector />
        </div>
        <details>
          <summary>Viewport Objects</summary>
          {#if viewer.loadedGroup}
            <div>
              <button class="tree-action-btn" onclick={() => toggleAllExpanded(true)}>Expand all</button>
              <button class="tree-action-btn" onclick={() => toggleAllExpanded(false)}>Collapse all</button>
            </div>
            {@render treeNode(viewer.loadedGroup)}
          {:else}
            <p>No viewport objects loaded.</p>
          {/if}
        </details>
      {/if}

      {#if activeTab === "rendering"}
        <RenderingTab
          bind:maxFps={viewerSettings.maxFps}
          bind:renderScale={viewerSettings.renderScale}
          {saveGraphicsPreferences}
          bind:toneMapping={viewerSettings.toneMapping}
          bind:toneExposure={viewerSettings.toneExposure}
          bind:ambientIntensity={viewerSettings.ambientIntensity}
          bind:dirIntensity={viewerSettings.dirIntensity}
          bind:shadowsEnabled={viewerSettings.shadowsEnabled}
          bind:shadowMapSize={viewerSettings.shadowMapSize}
          bind:shadowMapType={viewerSettings.shadowMapType}
          bind:anisotropy={viewerSettings.anisotropy}
          bind:envMapIntensity={viewerSettings.envMapIntensity}
          bind:backgroundColor={viewer.backgroundColor}
          bind:lightAzimuth
          bind:lightElevation
        />
      {/if}
      {#if activeTab === "layers"}
        <LayerTextEditor />
      {/if}
      {#if activeTab === "settings"}
        <SettingsTab
          bind:showWireframe={viewer.showWireframe}
          bind:showGrid={viewer.showGrid}
          bind:showBoundingBox={viewer.showBoundingBox}
          bind:moveSpeedFactor={controlsState.moveSpeedFactor}
          bind:rotSpeedFactor={controlsState.rotSpeedFactor}
          bind:invertMouseX={controlsState.invertMouseX}
          bind:invertMouseY={controlsState.invertMouseY}
          bind:mouseButtonLeft={controlsState.mouseButtonLeft}
          bind:mouseButtonMiddle={controlsState.mouseButtonMiddle}
          bind:mouseButtonRight={controlsState.mouseButtonRight}
          bind:keybindings={controlsState.keybindings}
          bind:backgroundColor={viewer.backgroundColor}
          bind:activeCameraIndex={viewer.activeCameraIndex}
          bind:omniverseUrl
          usdCameras={viewer.usdCameras}
          triangleCount={viewer.triangleCount}
          {saveControlPreferences}
          {formatKeyName}
          keysPressed={viewer.keysPressed}
          {updateOmniverseUrl}
        />
      {/if}
    </div>
  </aside>

  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="resize-handle" onmousedown={startResize} role="separator" tabindex="0"></div>

  <!-- Main View for 3D Render Surface -->
  <section class="viewport">
    {#if rootFile}
      <div class="top-toolbar">
        <button class="tool-btn" onclick={() => viewer.resetCameraView()} title="Reset View">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
            <path d="M3 3v5h5"></path>
          </svg>
          <span>Reset View</span>
        </button>

        <div style="position: relative;">
          <button class="tool-btn" onclick={() => (showFovSlider = !showFovSlider)} title="Field of View">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M2 12A10 10 0 1 0 22 12 10 10 0 1 0 2 12Z"></path>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
            <span>FOV: fov={viewer.fov}°</span>
          </button>
          {#if showFovSlider}
            <div class="slider-dropdown">
              <input
                type="range"
                class="slider"
                min="10"
                max="120"
                step="1"
                bind:value={viewer.fov}
                oninput={() => {
                  if (viewer.camera) {
                    viewer.camera.fov = viewer.fov;
                    viewer.camera.updateProjectionMatrix();
                  }
                }}
                onchange={() => localStorage.setItem("cameraFov", viewer.fov.toString())}
              />
            </div>
          {/if}
        </div>

        <button
          class="tool-btn"
          style={viewer.enableDamping ? "color: #0e639c;" : ""}
          onclick={() => {
            viewer.enableDamping = !viewer.enableDamping;
            if (viewer.controls) viewer.controls.enableDamping = viewer.enableDamping;
            localStorage.setItem("cameraDamping", viewer.enableDamping.toString());
          }}
          title="Toggle Camera Inertia"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            {#if viewer.enableDamping}
              <path d="M9.59 4.59A2 2 0 1 1 11 8H2"></path>
              <path d="M12.59 19.41A2 2 0 1 0 14 16H2"></path>
              <path d="M17.73 7.73A2.5 2.5 0 1 1 19.5 12H2"></path>
            {:else}
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line>
            {/if}
          </svg>
          <span>Inertia: {viewer.enableDamping ? "On" : "Off"}</span>
        </button>

        <div class="gizmo-sep"></div>
        <button
          class="tool-btn"
          class:active={gizmoMode === "translate"}
          disabled={!gizmoGate.attachable}
          onclick={() => (gizmoMode = "translate")}
          title="Move the selected prim (viewport gizmo)"
        >
          <span>Move</span>
        </button>
        <button
          class="tool-btn"
          class:active={gizmoMode === "rotate"}
          disabled={!gizmoGate.attachable}
          onclick={() => (gizmoMode = "rotate")}
          title="Rotate the selected prim (XYZ Euler degrees)"
        >
          <span>Rotate</span>
        </button>
        <button
          class="tool-btn"
          class:active={gizmoMode === "scale"}
          disabled={!gizmoGate.attachable}
          onclick={() => (gizmoMode = "scale")}
          title="Scale the selected prim"
        >
          <span>Scale</span>
        </button>
        {#if gizmoMessage}<span class="gizmo-status" title={gizmoMessage}>{gizmoMessage}</span>{/if}

        <div class="triangle-count" style="gap: 4px;">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M12 2L2 22h20L12 2z"></path>
          </svg>
          <span>{viewer.triangleCount.toLocaleString()}</span>
        </div>
      </div>
    {/if}

    <canvas bind:this={canvas} class="webgl-canvas" class:visible={!!rootFile}></canvas>

    {#if viewer.hasAnimation}
      <div class="timeline-overlay">
        <button
          class="icon-btn"
          style="color: #d4d4d4"
          onclick={() => (viewer.isPlayingAnim = !viewer.isPlayingAnim)}
          title={viewer.isPlayingAnim ? "Pause" : "Play"}
        >
          {viewer.isPlayingAnim ? "⏸" : "▶"}
        </button>
        <input
          type="range"
          class="timeline-slider slider"
          min="0"
          max={viewer.animationDuration}
          step="0.01"
          value={viewer.animationProgress}
          oninput={(e) => {
            viewer.animationProgress = parseFloat(e.currentTarget.value);
            void renderState.setStageTime(toAbsoluteTime(viewer.animationProgress, startTimeCode()));
            if (viewer.showBoundingBox && viewer.loadedGroup)
              viewer.sceneBox.setFromObject(viewer.loadedGroup, true);
            if (viewer.selectedNode && viewer.selectionHelper) {
              // @ts-ignore
              viewer.selectionHelper.box.setFromObject(viewer.selectedNode, true);
            }
          }}
          onmousedown={() => (viewer.isDraggingAnim = true)}
          onmouseup={() => (viewer.isDraggingAnim = false)}
        />
        <span class="timeline-time"
          >{viewer.animationProgress.toFixed(2)} / {viewer.animationDuration.toFixed(2)}</span
        >
      </div>
    {/if}

    {#if !rootFile}
      <div class="empty-state">
        <p>No USD scene loaded.</p>
        <p class="subtitle">Use File > Open USD... or the button to begin.</p>
      </div>
    {:else if loadingProgress}
      <div class="loading-overlay">
        <h3>Loading {loadingProgress.stage}...</h3>
      </div>
    {/if}
  </section>
</main>

{#if modalError}
  <ErrorModal error={modalError} onClose={closeErrorModal} />
{:else if stageModalLines !== null && !stageModalDismissed}
  <ErrorModal lines={stageModalLines} onClose={closeStageModal} />
{/if}

{#if showSaveModal}
  <SaveDialog onClose={() => (showSaveModal = false)} />
{/if}

{#if showCloseConfirm}
  <div class="modal-overlay" role="dialog" aria-modal="true">
    <div class="modal-content close-confirm-box">
      <h3>Unsaved changes</h3>
      <p>
        {editState.dirtyLayers.length} layer(s) have unsaved edits. Close anyway and lose
        them?
      </p>
      <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px;">
        <button class="tool-btn" onclick={() => (showCloseConfirm = false)}>Cancel</button>
        <button
          class="primary-btn"
          style="background: #a33;"
          onclick={() => {
            showCloseConfirm = false;
            void getCurrentWindow().destroy();
          }}>Close anyway</button
        >
      </div>
    </div>
  </div>
{/if}

{#if showExportModal}
  <ExportModal
    on:close={() => !isExporting && (showExportModal = false)}
    renderer={viewer.renderer}
    scene={viewer.scene}
    camera={viewer.camera}
    hasAnimation={viewer.hasAnimation}
    animationDuration={viewer.animationDuration}
    animationProgress={viewer.animationProgress}
    previewAt={(t: number) => renderState.setStageTime(toAbsoluteTime(t, startTimeCode()))}
    {isExporting}
    {exportProgress}
    {exportStage}
    on:export={handleExport}
  />
{/if}
