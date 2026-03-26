<script lang="ts">
  import "./page.css";
  import { invoke, convertFileSrc } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { onMount } from "svelte";
  import { patchUsdLayerForThree } from "$lib/three/usdUtils";
  import { formatKeyName } from "$lib/utils/format";
  import ErrorModal from "$lib/components/ErrorModal.svelte";
  import DependenciesTab from "$lib/components/DependenciesTab.svelte";
  import SceneTab from "$lib/components/SceneTab.svelte";
  import RenderingTab from "$lib/components/RenderingTab.svelte";
  import SettingsTab from "$lib/components/SettingsTab.svelte";
  import ExportModal from "$lib/components/ExportModal.svelte";
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
  import * as THREE from "three";
  import { RendererKit } from "$lib/three/RendererKit.svelte";
  import { USDLoader } from "three/addons/loaders/USDLoader.js";

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
  let activeTab = $state<"files" | "scene" | "rendering" | "settings">("files");

  // Rendering Controls
  let hasShownWindow = false;

  // Light Positioning State
  let lightAzimuth = $state<number>(45); // Degrees (-180 to 180)
  let lightElevation = $state<number>(45); // Degrees (0 to 90)

  let showFovSlider = $state<boolean>(false);

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
  let showExportModal = $state<boolean>(false);
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
        mixer: viewer.mixer,
        animationDuration: viewer.animationDuration,
        animationProgress: viewer.animationProgress,
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

  $effect(() => {
    if (viewer.scene) viewer.scene.background = new THREE.Color(viewer.backgroundColor);
  });

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

    // Global keyboard shortcuts
    const handleGlobalKeydown = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA")
        return;
      viewer.keysPressed.add(e.key.toLowerCase());
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        openUsdFile();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "e") {
        e.preventDefault();
        showExportModal = true;
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

    // Listeners for Rust events
    const unlisteners = [
      listen("open-export-modal", () => {
        console.log("RECEIVED open-export-modal from Rust!");
        showExportModal = true;
      }),
      listen<string>("usd-load-error", (event) => {
        loadingProgress = null;
        openErrorModal("Failed to extract or load USD: " + event.payload);
      }),
      listen<string>("usd-load-start", (event) => {
        rootFile = event.payload;
        loadingProgress = { stage: "Starting...", percent: 0 };
        dependencies = null;

        // Remove previous model if exists
        if (viewer.loadedGroup && viewer.scene) {
          viewer.scene.remove(viewer.loadedGroup);
          viewer.loadedGroup = null;
        }
      }),
      listen<{ stage: string; percent: number }>("usd-load-progress", (event) => {
        loadingProgress = event.payload;
      }),
      listen("usd-scene-loaded", async (event: any) => {
        loadingProgress = null;

        rootFile = event.payload.root_file;
        dependencies = event.payload.dependencies;

        if (rootFile && canvas) {
          try {
            if (!viewer.scene) return;
            const ext = rootFile.split(".").pop()?.toLowerCase() || "usd";

            const manager = new THREE.LoadingManager();
            manager.setURLModifier((url) => {
              if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("asset:")) return url;
              const cleanUrl = url.toLowerCase().split(/[?#]/)[0].replace(/\\/g, "/");
              const targetName = cleanUrl.split("/").pop() || "";

              const match = Object.entries(dependencies || {}).find(([k]) => {
                const cleanKey = k.toLowerCase().replace(/\\/g, "/");

                return (
                  cleanKey.endsWith(cleanUrl) ||
                  cleanUrl.endsWith(cleanKey) ||
                  cleanKey.split("/").pop() === targetName
                );
              });
              if (match?.[1]?.resolved && match[1].path) {
                return convertFileSrc(match[1].path);
              }
              return url;
            });

            const loader = new USDLoader(manager);
            let group: THREE.Group;

            loadingProgress = {
              stage: "Packing Remote Dependencies...",
              percent: 20,
            };

            const fflate = await import("fflate");
            const rootUrl = convertFileSrc(rootFile);
            // patchUsdLayerForThree imported from utils

            // Fetch the root file
            const rootRes = await fetch(rootUrl);
            if (!rootRes.ok) throw new Error(`Root fetch failed: HTTP ${rootRes.status} on ${rootUrl}`);
            const rawRootBytes = new Uint8Array(await rootRes.arrayBuffer());
            const rootBytes = patchUsdLayerForThree(rootFile, rawRootBytes);

            const rootFileName = rootFile.split(/[/\\]/).pop() || `usdbee_root.${ext}`;
            const zipData: Record<string, Uint8Array> = {
              [rootFileName]: rootBytes,
            };

            const depsEntries = Object.entries(dependencies || {});
            let loadedCount = 0;

            for (const [relPath, depInfo] of depsEntries) {
              if (depInfo.resolved && depInfo.path) {
                try {
                  loadingProgress = {
                    stage: `Packing ${relPath}...`,
                    percent: 20 + Math.floor((loadedCount / depsEntries.length) * 60),
                  };

                  const depUrl = convertFileSrc(depInfo.path);
                  const res = await fetch(depUrl);
                  if (!res.ok) throw new Error(`Dep fetch failed: HTTP ${res.status} on ${depUrl}`);
                  const rawBytes = new Uint8Array(await res.arrayBuffer());
                  const bytes = patchUsdLayerForThree(relPath, rawBytes);

                  const safePath = relPath.split("?")[0].replace(/:\/\//g, "/").replace(/:/g, "_");

                  const candidatePaths = new Set<string>([
                    relPath,
                    safePath,
                    safePath.replace(/\\/g, "/"),
                    safePath.replace(/\\/g, "/").replace(/^\.\//, ""),
                    safePath.replace(/\\/g, "/").replace(/^\/+/, ""),
                    safePath.split("/").pop()!?.split("\\").pop()! || "",
                  ]);

                  for (const candidatePath of candidatePaths) {
                    if (candidatePath) {
                      zipData[candidatePath] = bytes;
                    }
                  }

                  const baseName = safePath.split("/").pop()?.split("\\").pop();
                  if (baseName && baseName !== safePath && baseName !== rootFileName) {
                    zipData[baseName] = bytes;
                  }
                } catch (e) {
                  console.warn("Failed to load dependency into zip:", relPath, e);
                }
              }
              loadedCount++;
              if (loadedCount % 5 === 0 || loadedCount === depsEntries.length) {
                loadingProgress = {
                  stage: "Packing Remote Dependencies...",
                  percent: 20 + Math.floor((loadedCount / depsEntries.length) * 50),
                };
              }
            }

            loadingProgress = {
              stage: "Zipping Archive in Memory...",
              percent: 75,
            };

            const zippedBuffer = fflate.zipSync(zipData, { level: 0 });

            loadingProgress = { stage: "Parsing USDZ...", percent: 85 };
            group = loader.parse(zippedBuffer.buffer as ArrayBuffer);

            viewer.loadedGroup = group;

            // Extract Triangles and Cameras
            let tris = 0;
            const cams: THREE.Camera[] = [];
            group.traverse((obj) => {
              const mesh = obj as THREE.Mesh;
              if ((obj as any).isMesh) {
                mesh.castShadow = true;
                mesh.receiveShadow = true;
                if (mesh.geometry) {
                  if (mesh.geometry.index) {
                    tris += mesh.geometry.index.count / 3;
                  } else if (mesh.geometry.attributes.position) {
                    tris += mesh.geometry.attributes.position.count / 3;
                  }
                }
              }
              if ((obj as any).isCamera) cams.push(obj as THREE.Camera);

              if ((obj as any).isSkinnedMesh) {
                const skinnedMesh = obj as THREE.SkinnedMesh;
                let maxBoneIndex = -1;
                if (skinnedMesh.geometry && skinnedMesh.geometry.attributes.skinIndex) {
                  const skinIndices = skinnedMesh.geometry.attributes.skinIndex;
                  for (let i = 0; i < skinIndices.count * skinIndices.itemSize; i++) {
                    maxBoneIndex = Math.max(maxBoneIndex, skinIndices.array[i]);
                  }
                }

                let isSkeletonBroken =
                  !skinnedMesh.skeleton ||
                  !skinnedMesh.skeleton.bones ||
                  skinnedMesh.skeleton.bones.length <= maxBoneIndex;

                if (!isSkeletonBroken && skinnedMesh.skeleton && skinnedMesh.skeleton.bones) {
                  for (let i = 0; i <= maxBoneIndex; i++) {
                    if (!skinnedMesh.skeleton.bones[i]) isSkeletonBroken = true;
                  }
                }

                if (isSkeletonBroken) {
                  console.warn("SkinnedMesh missing or incomplete bones, downgrading to static Mesh");
                  (skinnedMesh as any).isSkinnedMesh = false; // Prevent MatrixWorld crashes
                  (skinnedMesh as any).getVertexPosition = THREE.Mesh.prototype.getVertexPosition; // Prevent applyBoneTransform
                  if (skinnedMesh.geometry) {
                    delete (skinnedMesh.geometry.attributes as any).skinIndex;
                    delete (skinnedMesh.geometry.attributes as any).skinWeight;
                  }
                }
              }
            });
            viewer.triangleCount = Math.floor(tris);
            viewer.usdCameras = cams;
            viewer.activeCameraIndex = -1;
            if (viewer.boxHelper) {
              viewer.scene.remove(viewer.boxHelper);
              viewer.boxHelper.dispose();
            }
            viewer.sceneBox = new THREE.Box3();

            viewer.boxHelper = new THREE.Box3Helper(viewer.sceneBox, new THREE.Color(0xffff00));
            viewer.boxHelper.visible = viewer.showBoundingBox;
            viewer.scene.add(viewer.boxHelper);

            // Setup Animation
            if (group.animations && group.animations.length > 0) {
              viewer.mixer = new THREE.AnimationMixer(group);
              viewer.hasAnimation = true;
              viewer.animationDuration = Math.max(
                ...group.animations.map((a: THREE.AnimationClip) => a.duration),
              );
              viewer.animationProgress = 0;
              viewer.isPlayingAnim = true;

              group.animations.forEach((clip: THREE.AnimationClip) => {
                viewer.mixer?.clipAction(clip).play();
              });
            } else {
              viewer.mixer = null;
              viewer.hasAnimation = false;
            }

            viewer.sceneBox.setFromObject(group, true);
            let size = viewer.sceneBox.getSize(new THREE.Vector3()).length();
            const center = viewer.sceneBox.getCenter(new THREE.Vector3());

            if (size === 0 || !isFinite(size)) {
              console.warn("Bounding box size is 0 or invalid! Falling back to default scale.");
              size = 10;
            }

            viewer.controls.reset();

            group.position.x -= center.x;
            group.position.y -= center.y;
            group.position.z -= center.z;

            viewer.camera.position.set(0, 0, 0);

            viewer.camera.position.x += size / 2.0;
            viewer.camera.position.y += size / 5.0;
            viewer.camera.position.z += size;

            viewer.camera.near = Math.max(0.01, size / 100);
            viewer.camera.far = size * 100;
            viewer.camera.updateProjectionMatrix();

            viewer.controls.target.set(0, 0, 0);
            viewer.controls.update();
            viewer.controls.saveState();

            if (viewer.gridHelper) {
              viewer.scene.remove(viewer.gridHelper);
              viewer.gridHelper.dispose();
            }
            const gridSize = Math.max(10, Math.pow(10, Math.ceil(Math.log10(size * 2))));
            viewer.gridHelper = new THREE.GridHelper(gridSize, 100, 0x888888, 0x444444);
            viewer.gridHelper.visible = viewer.showGrid;
            viewer.scene.add(viewer.gridHelper);

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

            let meshCount = 0;
            group.traverse((obj) => {
              if ((obj as any).isMesh) meshCount++;
            });
            if (meshCount === 0) {
              const helpers: THREE.SkeletonHelper[] = [];
              group.traverse((obj) => {
                if (obj.userData?.isSkelRoot || obj.type === "Bone") {
                  const helper = new THREE.SkeletonHelper(obj);
                  helpers.push(helper);
                }
              });
              helpers.forEach((h) => group.add(h));
            }

            viewer.scene.add(group);
            loadingProgress = null;
          } catch (err: any) {
            console.error("ThreeJS USD Load Error:", err);
            openErrorModal("Error Rendering USD:\n\n" + err.message);
            loadingProgress = null;

            let errMsg = err.message || String(err);
            if (
              errMsg.includes("Offset is outside the bounds of the DataView") ||
              errMsg.includes("Unsupported scalar type")
            ) {
              errMsg =
                "Three.js unsupported OpenUSD format: this file uses node properties or schemas not yet recognized by the WebGL viewport.\n\nRaw Error: " +
                errMsg;
            } else if (errMsg.includes("The first ZIP entry must be a USD layer")) {
              errMsg =
                "Three.js USD parser error: " +
                errMsg +
                "\nEnsure your root file format matches the internal structure.";
            }

            openErrorModal("Error Rendering USD:\n\n" + errMsg);
          }
        }
      }),
    ];

    if (canvas) {
      viewer.init(canvas);
    }

    // Cleanup listeners
    return () => {
      window.removeEventListener("keydown", handleGlobalKeydown);
      window.removeEventListener("keyup", handleGlobalKeyup);
      unlisteners.forEach((u) => u.then((f) => f()));
      viewer.dispose();
    };
  });

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
      <h2>USDA / Asset Graph</h2>
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
        <SceneTab loadedGroup={viewer.loadedGroup} {toggleAllExpanded} {updateSelection} {treeNode} />
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
            if (viewer.mixer) {
              viewer.mixer.setTime(viewer.animationProgress);
              if (viewer.showBoundingBox && viewer.loadedGroup)
                viewer.sceneBox.setFromObject(viewer.loadedGroup, true);
              if (viewer.selectedNode && viewer.selectionHelper) {
                // @ts-ignore
                viewer.selectionHelper.box.setFromObject(viewer.selectedNode, true);
              }
            }
          }}
          onmousedown={() => (viewer.isDraggingAnim = true)}
          onmouseup={() => (viewer.isDraggingAnim = false)}
        />
        <span class="timeline-time"
          >{viewer.animationProgress.toFixed(2)}s / {viewer.animationDuration.toFixed(2)}s</span
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
{/if}

{#if showExportModal}
  <ExportModal
    on:close={() => !isExporting && (showExportModal = false)}
    renderer={viewer.renderer}
    scene={viewer.scene}
    camera={viewer.camera}
    hasAnimation={viewer.hasAnimation}
    animationDuration={viewer.animationDuration}
    mixer={viewer.mixer}
    {isExporting}
    {exportProgress}
    {exportStage}
    on:export={handleExport}
  />
{/if}
