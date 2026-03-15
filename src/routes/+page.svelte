<script lang="ts">
  import "./page.css";
  import { invoke, convertFileSrc } from "@tauri-apps/api/core";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { listen } from "@tauri-apps/api/event";
  import { onMount } from "svelte";
  import { patchUsdLayerForThree } from "$lib/three/usdUtils";
  import { formatBytes, formatKeyName, isTexture } from "$lib/utils/format";
  import ErrorModal from "$lib/components/ErrorModal.svelte";
  import DependenciesTab from "$lib/components/DependenciesTab.svelte";
  import SceneTab from "$lib/components/SceneTab.svelte";
  import RenderingTab from "$lib/components/RenderingTab.svelte";
  import SettingsTab from "$lib/components/SettingsTab.svelte";
  import * as THREE from "three";
  import { USDLoader } from "three/addons/loaders/USDLoader.js";
  import { OrbitControls } from "three/addons/controls/OrbitControls.js";
  import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
  // @ts-ignore
  import Stats from "three/addons/libs/stats.module.js";

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
  let renderer: THREE.WebGLRenderer;
  let scene = $state.raw<THREE.Scene | null>(null);
  let camera: THREE.PerspectiveCamera;
  let controls: OrbitControls;
  let loadedGroup = $state.raw<THREE.Group | null>(null);
  let animationFrameId: number;
  let mixer: THREE.AnimationMixer | null = null;
  let clock: THREE.Clock;

  // Animation Control State
  let hasAnimation = $state<boolean>(false);
  let isPlayingAnim = $state<boolean>(true);
  let animationDuration = $state<number>(0);
  let animationProgress = $state<number>(0);
  let isDraggingAnim = false;

  // Viewer Settings State
  let showWireframe = $state(false);
  let showGrid = $state(true);
  let showBoundingBox = $state(false);
  let backgroundColor = $state("#1e1e1e");
  let activeTab = $state<"files" | "scene" | "rendering" | "settings">("files");

  // Scene Stats & Objects State
  let triangleCount = $state<number>(0);
  let usdCameras = $state<THREE.Camera[]>([]);
  let activeCameraIndex = $state<number>(-1);

  // Helpers & Threejs refs
  let gridHelper = $state.raw<THREE.GridHelper | null>(null);
  let sceneBox = $state.raw<THREE.Box3>(new THREE.Box3());
  let boxHelper = $state.raw<THREE.Box3Helper | null>(null);
  let selectionHelper = $state.raw<THREE.Box3Helper | null>(null);
  let selectedNode = $state.raw<any | null>(null);
  let dirLight = $state.raw<THREE.DirectionalLight | null>(null);
  let ambientLight = $state.raw<THREE.AmbientLight | null>(null);
  let stats: any = null;

  // Rendering Controls
  let maxFps = $state<number>(60); // 0 = Uncapped
  let toneExposure = $state<number>(0.4);
  let ambientIntensity = $state<number>(0.4);
  let dirIntensity = $state<number>(2.0);
  let shadowsEnabled = $state<boolean>(true);
  let renderScale = $state<number>(1.0);
  let shadowMapSize = $state<number>(2048);
  let shadowMapType = $state<string>("PCFSoft");
  let anisotropy = $state<number>(8);
  let envMapIntensity = $state<number>(1.0);
  let toneMapping = $state<string>("ACESFilmic");
  let hasShownWindow = false;

  // Light Positioning State
  let lightAzimuth = $state<number>(45); // Degrees (-180 to 180)
  let lightElevation = $state<number>(45); // Degrees (0 to 90)
  let sceneCenter = $state.raw<THREE.Vector3>(new THREE.Vector3(0, 0, 0));
  let sceneSize = $state<number>(10);
  let fov = $state<number>(75);
  let showFovSlider = $state<boolean>(false);
  let enableDamping = $state<boolean>(true);

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

  // Keybindings State
  let keybindings = $state({
    forward: "z",
    backward: "s",
    left: "q",
    right: "d",
    turnLeft: "a",
    turnRight: "e",
    up: " ",
    down: "control",
  });
  let keysPressed = new Set<string>();

  // Control Preferences State
  let moveSpeedFactor = $state<number>(1.0);
  let rotSpeedFactor = $state<number>(1.0);
  let invertMouseX = $state<boolean>(false);
  let invertMouseY = $state<boolean>(false);
  let mouseButtonLeft = $state<string>("rotate");
  let mouseButtonMiddle = $state<string>("zoom");
  let mouseButtonRight = $state<string>("pan");

  let omniverseUrl = $state<string>("http://localhost:34080");

  async function updateOmniverseUrl() {
    try {
      await invoke("set_omniverse_url", { url: omniverseUrl });
    } catch (e) {
      console.error("Failed to save Omniverse URL:", e);
    }
  }

  function saveControlPreferences() {
    localStorage.setItem(
      "usdbee_controls",
      JSON.stringify({
        moveSpeedFactor,
        rotSpeedFactor,
        invertMouseX,
        invertMouseY,
        mouseButtonLeft,
        mouseButtonMiddle,
        mouseButtonRight,
      }),
    );
  }

  function saveGraphicsPreferences() {
    localStorage.setItem(
      "usdbee_graphics",
      JSON.stringify({
        shadowsEnabled,
        renderScale,
        shadowMapSize,
        shadowMapType,
        anisotropy,
        envMapIntensity,
        toneMapping,
      }),
    );
  }

  function openErrorModal(msg: string) {
    modalError = msg;
  }

  function closeErrorModal() {
    modalError = null;
  }

  let filteredDependencies = $derived(
    dependencies
      ? Object.entries(dependencies).filter(([path, _]) =>
          path.toLowerCase().includes(filterText.toLowerCase()),
        )
      : [],
  );

  $effect(() => {
    if (scene) scene.background = new THREE.Color(backgroundColor);
  });

  $effect(() => {
    if (gridHelper) gridHelper.visible = showGrid;
  });

  $effect(() => {
    if (boxHelper) boxHelper.visible = showBoundingBox;
  });

  $effect(() => {
    const scale = renderScale;
    const sMapSize = shadowMapSize;
    const sMapType = shadowMapType;
    const tMapping = toneMapping;
    const aniso = anisotropy;
    const eIntensity = envMapIntensity;
    const _groupTrigger = loadedGroup;

    if (renderer) {
      renderer.setPixelRatio(window.devicePixelRatio * scale);

      let needsMaterialUpdate = false;

      const newToneMapping =
        tMapping === "ACESFilmic"
          ? THREE.ACESFilmicToneMapping
          : tMapping === "AgX"
            ? (THREE as any).AgXToneMapping
            : tMapping === "Reinhard"
              ? THREE.ReinhardToneMapping
              : THREE.LinearToneMapping;
      if (renderer.toneMapping !== newToneMapping && newToneMapping !== undefined) {
        renderer.toneMapping = newToneMapping;
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
      if (renderer.shadowMap.type !== newShadowType) {
        renderer.shadowMap.type = newShadowType;
        needsMaterialUpdate = true;
      }

      if (scene) {
        scene.traverse((obj: any) => {
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
                  m[key].anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), aniso);

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

    if (dirLight && dirLight.shadow.mapSize.width !== sMapSize) {
      dirLight.shadow.mapSize.width = sMapSize;
      dirLight.shadow.mapSize.height = sMapSize;
      if (dirLight.shadow.map) {
        dirLight.shadow.map.dispose();
        dirLight.shadow.map = null as any;
      }
    }
  });

  $effect(() => {
    if (renderer) renderer.toneMappingExposure = toneExposure;
    if (ambientLight) ambientLight.intensity = ambientIntensity;
    if (dirLight) {
      dirLight.intensity = dirIntensity;
      dirLight.castShadow = shadowsEnabled;

      const phi = THREE.MathUtils.degToRad(lightAzimuth);
      const theta = THREE.MathUtils.degToRad(90 - lightElevation);

      const radius = sceneSize * 2.0; // Distance based on scene scale
      const x = radius * Math.sin(theta) * Math.sin(phi);
      const y = radius * Math.cos(theta);
      const z = radius * Math.sin(theta) * Math.cos(phi);

      dirLight.position.copy(sceneCenter).add(new THREE.Vector3(x, y, z));
      dirLight.target.position.copy(sceneCenter);
      dirLight.target.updateMatrixWorld();
    }
  });

  $effect(() => {
    if (loadedGroup) {
      loadedGroup.traverse((obj: any) => {
        if (obj.isMesh && obj.material) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          mats.forEach((m: any) => (m.wireframe = showWireframe));
        }
      });
    }
  });

  $effect(() => {
    const mLeft = mouseButtonLeft;
    const mMiddle = mouseButtonMiddle;
    const mRight = mouseButtonRight;
    const speed = rotSpeedFactor;

    if (controls) {
      const MOUSE_MAPPING: Record<string, number> = {
        rotate: THREE.MOUSE.ROTATE,
        pan: THREE.MOUSE.PAN,
        zoom: THREE.MOUSE.DOLLY,
      };
      controls.rotateSpeed = speed;
      controls.mouseButtons = {
        LEFT: MOUSE_MAPPING[mLeft] || THREE.MOUSE.ROTATE,
        MIDDLE: MOUSE_MAPPING[mMiddle] || THREE.MOUSE.DOLLY,
        RIGHT: MOUSE_MAPPING[mRight] || THREE.MOUSE.PAN,
      };
    }
  });

  $effect(() => {
    if (camera && fov) {
      if (camera.fov !== fov) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
    }
  });

  onMount(() => {
    const savedFov = localStorage.getItem("cameraFov");
    if (savedFov) {
      fov = parseFloat(savedFov);
    }

    const savedDamping = localStorage.getItem("cameraDamping");
    if (savedDamping !== null) {
      enableDamping = savedDamping === "true";
    }

    // Global keyboard shortcuts
    const handleGlobalKeydown = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA")
        return;
      keysPressed.add(e.key.toLowerCase());
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        openUsdFile();
      }
    };
    const handleGlobalKeyup = (e: KeyboardEvent) => {
      keysPressed.delete(e.key.toLowerCase());
    };
    window.addEventListener("keydown", handleGlobalKeydown);
    window.addEventListener("keyup", handleGlobalKeyup);

    // Initialize backend config
    invoke<string>("get_omniverse_url")
      .then((url) => {
        if (url) omniverseUrl = url;
      })
      .catch(console.warn);

    // Restore Keybindings
    const savedKeys = localStorage.getItem("usdbee_keybindings");
    if (savedKeys) {
      try {
        keybindings = { ...keybindings, ...JSON.parse(savedKeys) };
      } catch (e) {}
    }

    // Restore Control Preferences
    const savedControls = localStorage.getItem("usdbee_controls");
    if (savedControls) {
      try {
        const parsed = JSON.parse(savedControls);
        if (parsed.moveSpeedFactor !== undefined) moveSpeedFactor = parsed.moveSpeedFactor;
        if (parsed.rotSpeedFactor !== undefined) rotSpeedFactor = parsed.rotSpeedFactor;
        if (parsed.invertMouseX !== undefined) invertMouseX = parsed.invertMouseX;
        if (parsed.invertMouseY !== undefined) invertMouseY = parsed.invertMouseY;
        if (parsed.mouseButtonLeft !== undefined) mouseButtonLeft = parsed.mouseButtonLeft;
        if (parsed.mouseButtonMiddle !== undefined) mouseButtonMiddle = parsed.mouseButtonMiddle;
        if (parsed.mouseButtonRight !== undefined) mouseButtonRight = parsed.mouseButtonRight;
      } catch (e) {}
    }

    // Restore Graphics Preferences
    const savedGraphics = localStorage.getItem("usdbee_graphics");
    if (savedGraphics) {
      try {
        const parsed = JSON.parse(savedGraphics);
        if (parsed.shadowsEnabled !== undefined) shadowsEnabled = parsed.shadowsEnabled;
        if (parsed.renderScale !== undefined) renderScale = parsed.renderScale;
        if (parsed.shadowMapSize !== undefined) shadowMapSize = parsed.shadowMapSize;
        if (parsed.shadowMapType !== undefined) shadowMapType = parsed.shadowMapType;
        if (parsed.anisotropy !== undefined) anisotropy = parsed.anisotropy;
        if (parsed.envMapIntensity !== undefined) envMapIntensity = parsed.envMapIntensity;
        if (parsed.toneMapping !== undefined) toneMapping = parsed.toneMapping;
      } catch (e) {}
    }

    const savedWidth = localStorage.getItem("sidebarWidth");
    if (savedWidth) {
      let parsed = parseInt(savedWidth);
      if (!isNaN(parsed) && parsed >= 150) {
        sidebarWidth = parsed;
      }
    }

    // Listeners for Rust events
    const unlisteners = [
      listen<string>("usd-load-start", (event) => {
        rootFile = event.payload;
        loadingProgress = { stage: "Starting...", percent: 0 };
        dependencies = null;

        // Remove previous model if exists
        if (loadedGroup && scene) {
          scene.remove(loadedGroup);
          loadedGroup = null;
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
            if (!scene) return;
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
                  const rawBytes = new Uint8Array(await res.arrayBuffer());
                  const bytes = patchUsdLayerForThree(relPath, rawBytes);

                  const safePath = relPath.split("?")[0].replace(/:\/\//g, "/").replace(/:/g, "_");

                  const candidatePaths = new Set<string>([
                    relPath,
                    safePath,
                    safePath.replace(/\\/g, "/"),
                    safePath.replace(/\\/g, "/").replace(/^\.\//, ""),
                    safePath.replace(/\\/g, "/").replace(/^\/+/, ""),
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

            loadedGroup = group;

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
            triangleCount = Math.floor(tris);
            usdCameras = cams;
            activeCameraIndex = -1;
            if (boxHelper) {
              scene.remove(boxHelper);
              boxHelper.dispose();
            }
            sceneBox = new THREE.Box3();

            boxHelper = new THREE.Box3Helper(sceneBox, new THREE.Color(0xffff00));
            boxHelper.visible = showBoundingBox;
            scene.add(boxHelper);

            // Setup Animation
            if (group.animations && group.animations.length > 0) {
              mixer = new THREE.AnimationMixer(group);
              hasAnimation = true;
              animationDuration = Math.max(...group.animations.map((a: THREE.AnimationClip) => a.duration));
              animationProgress = 0;
              isPlayingAnim = true;

              group.animations.forEach((clip: THREE.AnimationClip) => {
                mixer?.clipAction(clip).play();
              });
            } else {
              mixer = null;
              hasAnimation = false;
            }

            sceneBox.setFromObject(group, true);
            let size = sceneBox.getSize(new THREE.Vector3()).length();
            const center = sceneBox.getCenter(new THREE.Vector3());

            if (size === 0 || !isFinite(size)) {
              console.warn("Bounding box size is 0 or invalid! Falling back to default scale.");
              size = 10;
            }

            controls.reset();

            group.position.x -= center.x;
            group.position.y -= center.y;
            group.position.z -= center.z;

            camera.position.set(0, 0, 0);

            camera.position.x += size / 2.0;
            camera.position.y += size / 5.0;
            camera.position.z += size;

            camera.near = Math.max(0.01, size / 100);
            camera.far = size * 100;
            camera.updateProjectionMatrix();

            controls.target.set(0, 0, 0);
            controls.update();
            controls.saveState();

            if (gridHelper) {
              scene.remove(gridHelper);
              gridHelper.dispose();
            }
            const gridSize = Math.max(10, Math.pow(10, Math.ceil(Math.log10(size * 2))));
            gridHelper = new THREE.GridHelper(gridSize, 100, 0x888888, 0x444444);
            gridHelper.visible = showGrid;
            scene.add(gridHelper);

            sceneCenter = center;
            sceneSize = size;

            if (dirLight) {
              const d = size * 1.2;
              dirLight.shadow.camera.left = -d;
              dirLight.shadow.camera.right = d;
              dirLight.shadow.camera.top = d;
              dirLight.shadow.camera.bottom = -d;
              dirLight.shadow.camera.near = 0.1;
              dirLight.shadow.camera.far = size * 4;
              dirLight.shadow.camera.updateProjectionMatrix();
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

            scene.add(group);
            loadingProgress = null;
          } catch (err: any) {
            console.error("ThreeJS USD Load Error:", err);
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
      initThreeJS();
    }

    // Cleanup listeners
    return () => {
      window.removeEventListener("keydown", handleGlobalKeydown);
      window.removeEventListener("keyup", handleGlobalKeyup);
      unlisteners.forEach((u) => u.then((f) => f()));
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
      if (renderer) renderer.dispose();
    };
  });

  function initThreeJS() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1e1e1e);

    const w = canvas.clientWidth || 800;
    const h = canvas.clientHeight || 600;
    const aspect = w / h;
    camera = new THREE.PerspectiveCamera(fov, aspect, 0.1, 1000);
    camera.position.z = 3;

    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
    });
    renderer.setSize(w, h, false);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;

    // Enable shadows
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = enableDamping;
    controls.dampingFactor = 0.05;

    const rawControls = controls as any;
    if (rawControls._rotateLeft && rawControls._rotateUp) {
      const orig_rotateLeft = rawControls._rotateLeft.bind(rawControls);
      const orig_rotateUp = rawControls._rotateUp.bind(rawControls);
      rawControls._rotateLeft = function (angle: number) {
        orig_rotateLeft(invertMouseX ? -angle : angle);
      };
      rawControls._rotateUp = function (angle: number) {
        orig_rotateUp(invertMouseY ? -angle : angle);
      };
    }

    const MOUSE_MAPPING: Record<string, number> = {
      rotate: THREE.MOUSE.ROTATE,
      pan: THREE.MOUSE.PAN,
      zoom: THREE.MOUSE.DOLLY,
    };
    controls.rotateSpeed = rotSpeedFactor;
    controls.mouseButtons = {
      LEFT: MOUSE_MAPPING[mouseButtonLeft] || THREE.MOUSE.ROTATE,
      MIDDLE: MOUSE_MAPPING[mouseButtonMiddle] || THREE.MOUSE.DOLLY,
      RIGHT: MOUSE_MAPPING[mouseButtonRight] || THREE.MOUSE.PAN,
    };

    // Setup Grid
    gridHelper = new THREE.GridHelper(100, 100, 0x888888, 0x444444);
    gridHelper.visible = showGrid;
    scene.add(gridHelper);

    // Setup Stats
    stats = new Stats();
    stats.dom.style.position = "absolute";
    stats.dom.style.top = "10px";
    stats.dom.style.right = "10px";
    stats.dom.style.left = "auto"; // override default left
    if (canvas && canvas.parentElement) {
      canvas.parentElement.appendChild(stats.dom);
    }

    // Add lighting suitable for models
    ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambientLight);

    dirLight = new THREE.DirectionalLight(0xffffff, 2.0);
    dirLight.position.set(5, 10, 7);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.bias = -0.0001; // Reduce shadow acne
    scene.add(dirLight);

    // Handles window resizing correctly
    const resizeObserver = new ResizeObserver(() => {
      if (!canvas) return;
      const width = canvas.parentElement?.clientWidth || canvas.clientWidth || 800;
      const height = canvas.parentElement?.clientHeight || canvas.clientHeight || 600;

      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    });

    resizeObserver.observe(canvas.parentElement!);

    // Start animation loop
    clock = new THREE.Clock();
    let lastFrameTime = 0;
    let lastNavTime = performance.now();

    function animate(time: DOMHighResTimeStamp = 0) {
      animationFrameId = requestAnimationFrame(animate);

      if (maxFps > 0 && time > 0) {
        const interval = 1000 / maxFps;
        const elapsed = time - lastFrameTime;

        if (elapsed < interval) return;
        lastFrameTime = time - (elapsed % interval);
      } else if (maxFps === 0) {
        lastFrameTime = time;
      }

      if (mixer && !isDraggingAnim) {
        const delta = clock.getDelta();
        if (isPlayingAnim) {
          mixer.update(delta);

          animationProgress += delta;
          if (animationProgress > animationDuration) {
            animationProgress %= animationDuration;
          }
        }
      } else if (mixer) {
        clock.getDelta();
      }

      if (keysPressed.size > 0 && camera && controls) {
        const currentNavTime = performance.now();
        const navDt = Math.min((currentNavTime - lastNavTime) / 1000, 0.1);
        const baseSpeed = Math.max(1.0, sceneSize * 0.5) * navDt;
        const speed = baseSpeed * moveSpeedFactor;
        const turnSpeed = 1.5 * navDt;

        let moved = false;
        const forward = new THREE.Vector3();
        camera.getWorldDirection(forward);
        const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();

        if (keysPressed.has(keybindings.forward)) {
          camera.position.addScaledVector(forward, speed);
          controls.target.addScaledVector(forward, speed);
          moved = true;
        }
        if (keysPressed.has(keybindings.backward)) {
          camera.position.addScaledVector(forward, -speed);
          controls.target.addScaledVector(forward, -speed);
          moved = true;
        }
        if (keysPressed.has(keybindings.left)) {
          camera.position.addScaledVector(right, -speed);
          controls.target.addScaledVector(right, -speed);
          moved = true;
        }
        if (keysPressed.has(keybindings.right)) {
          camera.position.addScaledVector(right, speed);
          controls.target.addScaledVector(right, speed);
          moved = true;
        }
        if (keysPressed.has(keybindings.up)) {
          camera.position.addScaledVector(camera.up, speed);
          controls.target.addScaledVector(camera.up, speed);
          moved = true;
        }
        if (keysPressed.has(keybindings.down)) {
          camera.position.addScaledVector(camera.up, -speed);
          controls.target.addScaledVector(camera.up, -speed);
          moved = true;
        }

        if (keysPressed.has(keybindings.turnLeft)) {
          forward.applyAxisAngle(camera.up, turnSpeed);
          controls.target
            .copy(camera.position)
            .add(forward.clone().multiplyScalar(Math.max(1.0, camera.position.distanceTo(controls.target))));
          moved = true;
        }
        if (keysPressed.has(keybindings.turnRight)) {
          forward.applyAxisAngle(camera.up, -turnSpeed);
          controls.target
            .copy(camera.position)
            .add(forward.clone().multiplyScalar(Math.max(1.0, camera.position.distanceTo(controls.target))));
          moved = true;
        }
        if (moved) camera.updateProjectionMatrix();
      }
      lastNavTime = performance.now();

      if (controls) controls.update();
      if (stats) stats.update();
      if (showBoundingBox && loadedGroup) {
        sceneBox.setFromObject(loadedGroup, true);
      }
      if (selectedNode && selectionHelper) {
        selectionHelper.box.setFromObject(selectedNode, true);
      }

      const renderCam =
        activeCameraIndex >= 0 && usdCameras[activeCameraIndex] ? usdCameras[activeCameraIndex] : camera;

      if (activeCameraIndex >= 0 && usdCameras[activeCameraIndex]) {
        const c = usdCameras[activeCameraIndex] as THREE.PerspectiveCamera;

        if (c.aspect !== undefined) {
          const width = canvas.parentElement?.clientWidth || canvas.clientWidth;
          const height = canvas.parentElement?.clientHeight || canvas.clientHeight;
          c.aspect = width / height;
          c.updateProjectionMatrix();
        }
      }

      if (!scene) return;
      renderer.render(scene, renderCam as THREE.Camera);

      if (!hasShownWindow) {
        hasShownWindow = true;
        getCurrentWindow()
          .show()
          .catch((err) => console.error("Could not show window", err));
      }
    }
    animate();
  }

  async function openUsdFile() {
    await invoke("trigger_open_usd_dialog");
  }

  function resetCameraView() {
    if (!camera || !controls || !sceneSize) return;

    // Restore the OrbitControls exact target, un-pan, un-zoom, and original spherical coordinates
    controls.reset();

    fov = 75;
    camera.fov = fov;
    localStorage.setItem("cameraFov", "75");

    camera.updateProjectionMatrix();
    controls.update();
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

      if (loadedGroup) {
        const threeColor = new THREE.Color(color);
        const searchName = path.split(/[\\/]/).pop()?.split(".")[0]?.toLowerCase() || "";

        loadedGroup.traverse((child: any) => {
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
    selectedNode = selectedNode;
  }

  function updateSelection(node: any) {
    if (!scene) return;

    // Toggle off if already selected
    if (node && selectedNodeId === node.uuid) {
      selectedNodeId = null;
      selectedNode = null;
      if (selectionHelper) {
        scene.remove(selectionHelper);
        selectionHelper.dispose();
        selectionHelper = null;
      }
      return;
    }

    selectedNodeId = node ? node.uuid : null;
    selectedNode = node ? node : null;

    // Remove previous selection helper
    if (selectionHelper) {
      scene.remove(selectionHelper);
      selectionHelper.dispose();
      selectionHelper = null;
    }

    if (node) {
      const box = new THREE.Box3();
      box.setFromObject(node, true);
      selectionHelper = new THREE.Box3Helper(box, new THREE.Color(0xffaa00)); // Orange highlight
      scene.add(selectionHelper);
    }
  }

  // Expand / Collapse All
  function toggleAllExpanded(expand: boolean) {
    if (!loadedGroup) return;
    const applyExpand = (node: any) => {
      expandedNodes[node.uuid] = expand;
      if (node.children) {
        for (let i = 0; i < node.children.length; i++) {
          applyExpand(node.children[i]);
        }
      }
    };
    applyExpand(loadedGroup);
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
      <button class="primary-btn" onclick={openUsdFile}>Open USD...</button>
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
        <SceneTab {loadedGroup} {toggleAllExpanded} {updateSelection} {treeNode} />
      {/if}

      {#if activeTab === "rendering"}
        <RenderingTab
          bind:maxFps
          bind:renderScale
          {saveGraphicsPreferences}
          bind:toneMapping
          bind:toneExposure
          bind:ambientIntensity
          bind:dirIntensity
          bind:shadowsEnabled
          bind:shadowMapSize
          bind:shadowMapType
          bind:anisotropy
          bind:envMapIntensity
          bind:backgroundColor
          bind:lightAzimuth
          bind:lightElevation
        />
      {/if}
      {#if activeTab === "settings"}
        <SettingsTab
          bind:showWireframe
          bind:showGrid
          bind:showBoundingBox
          bind:moveSpeedFactor
          bind:rotSpeedFactor
          bind:invertMouseX
          bind:invertMouseY
          bind:mouseButtonLeft
          bind:mouseButtonMiddle
          bind:mouseButtonRight
          bind:keybindings
          bind:backgroundColor
          bind:activeCameraIndex
          bind:omniverseUrl
          {usdCameras}
          {triangleCount}
          {saveControlPreferences}
          {formatKeyName}
          {keysPressed}
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
        <button class="tool-btn" onclick={resetCameraView} title="Reset View">
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
            <span>FOV: {fov}°</span>
          </button>
          {#if showFovSlider}
            <div class="slider-dropdown">
              <input
                type="range"
                class="slider"
                min="10"
                max="120"
                step="1"
                bind:value={fov}
                oninput={() => {
                  if (camera) {
                    camera.fov = fov;
                    camera.updateProjectionMatrix();
                  }
                }}
                onchange={() => localStorage.setItem("cameraFov", fov.toString())}
              />
            </div>
          {/if}
        </div>

        <button
          class="tool-btn"
          style={enableDamping ? "color: #0e639c;" : ""}
          onclick={() => {
            enableDamping = !enableDamping;
            if (controls) controls.enableDamping = enableDamping;
            localStorage.setItem("cameraDamping", enableDamping.toString());
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
            {#if enableDamping}
              <path d="M9.59 4.59A2 2 0 1 1 11 8H2"></path>
              <path d="M12.59 19.41A2 2 0 1 0 14 16H2"></path>
              <path d="M17.73 7.73A2.5 2.5 0 1 1 19.5 12H2"></path>
            {:else}
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line>
            {/if}
          </svg>
          <span>Inertia: {enableDamping ? "On" : "Off"}</span>
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
          <span>{triangleCount.toLocaleString()}</span>
        </div>
      </div>
    {/if}

    <canvas bind:this={canvas} class="webgl-canvas" class:visible={!!rootFile}></canvas>

    {#if hasAnimation}
      <div class="timeline-overlay">
        <button
          class="icon-btn"
          style="color: #d4d4d4"
          onclick={() => (isPlayingAnim = !isPlayingAnim)}
          title={isPlayingAnim ? "Pause" : "Play"}
        >
          {isPlayingAnim ? "⏸" : "▶"}
        </button>
        <input
          type="range"
          class="timeline-slider slider"
          min="0"
          max={animationDuration}
          step="0.01"
          value={animationProgress}
          oninput={(e) => {
            animationProgress = parseFloat(e.currentTarget.value);
            if (mixer) {
              mixer.setTime(animationProgress);
              if (showBoundingBox && loadedGroup) sceneBox.setFromObject(loadedGroup, true);
              if (selectedNode && selectionHelper) {
                // @ts-ignore
                selectionHelper.box.setFromObject(selectedNode, true);
              }
            }
          }}
          onmousedown={() => (isDraggingAnim = true)}
          onmouseup={() => (isDraggingAnim = false)}
        />
        <span class="timeline-time">{animationProgress.toFixed(2)}s / {animationDuration.toFixed(2)}s</span>
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
