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
  import { filteredDependencies, loadOrchestrator } from "$lib/state/loadOrchestrator.svelte";
  import { confirmCloseNeeded } from "$lib/state/closeGuard";
  import { layerTextState } from "$lib/state/layerTextState.svelte";
  import { renderState, toAbsoluteTime } from "$lib/render/renderState.svelte";
  import type { GizmoMode } from "$lib/render/xformOps";
  import { stageModalErrorLines } from "$lib/stage/modalErrors";
  import * as THREE from "three";
  import Viewport from "$lib/components/Viewport.svelte";
  import { RendererKit } from "$lib/three/RendererKit.svelte";

  // State
  let viewer = new RendererKit();
  let activeTab = $state<"files" | "scene" | "rendering" | "settings" | "layers">("files");

  // Rendering Controls
  let hasShownWindow = false;

  // Light Positioning State (bound into RenderingTab, fed to the Viewport)
  let lightAzimuth = $state<number>(45); // Degrees (-180 to 180)
  let lightElevation = $state<number>(45); // Degrees (0 to 90)

  // The active gizmo mode: the Viewport/Toolbar toggle it, the keyboard
  // shortcuts below write it. Owned here so the shortcuts stay page glue.
  let gizmoMode = $state<GizmoMode>("translate");

  // Hierarchy Tree State
  let expandedNodes = $state<Record<string, boolean>>({});
  let visibilityMap = $state<Record<string, boolean>>({});
  let colorUpdateMap = $state<Record<string, number>>({});
  let selectedNodeId = $state<string | null>(null);

  // Sidebar resize state
  let sidebarWidth = $state<number>(320);
  let isResizing = $state<boolean>(false);
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
            loadOrchestrator.loadingProgress = { stage, percent };
          }
        },
        onComplete: () => {
          showExportModal = false;
          isExporting = false;
          loadOrchestrator.loadingProgress = null;
        },
        onError: (msg) => {
          loadOrchestrator.openErrorModal(msg);
          isExporting = false;
          loadOrchestrator.loadingProgress = null;
        },
      },
    );
  }

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
    viewer.showExportModal = showExportModal;
  });

  onMount(() => {
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
        void loadOrchestrator.openUsdFile();
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
      // Configurable gizmo mode shortcuts (Settings > Keyboard; defaults 1/2/3).
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const key = e.key.toLowerCase();
        const kb = controlsState.keybindings;
        if (key === kb.gizmoTranslate) gizmoMode = "translate";
        else if (key === kb.gizmoRotate) gizmoMode = "rotate";
        else if (key === kb.gizmoScale) gizmoMode = "scale";
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
      // The scene-side of usd-stage-changed moves with the Viewport; the
      // page keeps the selected-prim details refresh for the inspector.
      listen("usd-stage-changed", () => {
        void stageState.refreshAfterEdit();
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
        if (confirmCloseNeeded(editState.dirtyLayers.length, layerTextState.draftDirty)) {
          event.preventDefault();
          showCloseConfirm = true;
        }
      }),
    );

    // Cleanup listeners
    return () => {
      window.removeEventListener("keydown", handleGlobalKeydown);
      window.removeEventListener("keyup", handleGlobalKeyup);
      unlisteners.forEach((u) => u.then((f) => f()));
      renderState.onTimeChange = null;
    };
  });

  async function replaceWithColor(path: string, event: Event) {
    if (!loadOrchestrator.dependencies) return;
    const input = event.target as HTMLInputElement;
    const color = input.value;
    try {
      await invoke("set_fallback_color", { path, color });

      // Update local state to reflect the change
      loadOrchestrator.dependencies[path] = {
        ...loadOrchestrator.dependencies[path],
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
        <button class="primary-btn" onclick={() => void loadOrchestrator.openUsdFile()} title="Open USD File">
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
          disabled={loadOrchestrator.loadingProgress !== null || loadOrchestrator.rootFile === null}
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

    {#if loadOrchestrator.loadingProgress}
      <div class="progress-box">
        <p>{loadOrchestrator.loadingProgress.stage}</p>
        <div class="progress-bar">
          <div class="progress-fill" style="width: {loadOrchestrator.loadingProgress.percent}%"></div>
        </div>
      </div>
    {/if}

    <div class="dependency-tree">
      {#if activeTab === "files"}
        <DependenciesTab
          rootFile={loadOrchestrator.rootFile}
          dependencies={loadOrchestrator.dependencies}
          filteredDependencies={filteredDependencies()}
          bind:filterText={loadOrchestrator.filterText}
          openErrorModal={loadOrchestrator.openErrorModal}
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
  <Viewport {viewer} bind:gizmoMode {lightAzimuth} {lightElevation} />
</main>

{#if loadOrchestrator.modalError}
  <ErrorModal error={loadOrchestrator.modalError} onClose={loadOrchestrator.closeErrorModal} />
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
        {editState.dirtyLayers.length} layer(s) have unsaved edits. Close anyway and lose them?
      </p>
      <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px;">
        <button class="tool-btn" onclick={() => (showCloseConfirm = false)}>Cancel</button>
        <button
          class="primary-btn"
          style="background: #a33;"
          onclick={() => {
            showCloseConfirm = false;
            getCurrentWindow().destroy().catch(console.warn);
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
