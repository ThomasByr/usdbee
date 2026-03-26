import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
// @ts-ignore
import Stats from "three/addons/libs/stats.module.js";
import { viewerSettings } from "$lib/state/viewerSettings.svelte";
import { controlsState } from "$lib/state/controlsState.svelte";
import { getCurrentWindow } from "@tauri-apps/api/window";

export class RendererKit {
  canvas: HTMLCanvasElement | null = null;
  renderer = $state.raw<THREE.WebGLRenderer>() as THREE.WebGLRenderer;
  scene = $state.raw<THREE.Scene>() as THREE.Scene;
  camera = $state.raw<THREE.PerspectiveCamera>() as THREE.PerspectiveCamera;
  controls = $state.raw<OrbitControls>() as OrbitControls;

  gridHelper = $state.raw<THREE.GridHelper | null>(null);
  sceneBox = $state.raw<THREE.Box3>(new THREE.Box3());
  boxHelper = $state.raw<THREE.Box3Helper | null>(null);
  selectionHelper = $state.raw<THREE.Box3Helper | null>(null);
  selectedNode = $state.raw<any | null>(null);

  dirLight = $state.raw<THREE.DirectionalLight | null>(null);
  ambientLight = $state.raw<THREE.AmbientLight | null>(null);
  stats: any = null;

  loadedGroup = $state.raw<THREE.Group | null>(null);
  mixer: THREE.AnimationMixer | null = $state.raw(null);
  clock: THREE.Clock;
  usdCameras = $state<THREE.Camera[]>([]);
  activeCameraIndex = $state<number>(-1);

  hasAnimation = $state<boolean>(false);
  isPlayingAnim = $state<boolean>(true);
  animationDuration = $state<number>(0);
  animationProgress = $state<number>(0);
  isDraggingAnim = $state<boolean>(false);

  triangleCount = $state<number>(0);
  sceneCenter = $state.raw<THREE.Vector3>(new THREE.Vector3(0, 0, 0));
  sceneSize = $state<number>(10);

  // Settings
  showWireframe = $state(false);
  showGrid = $state(true);
  showBoundingBox = $state(false);
  backgroundColor = $state("#1e1e1e");
  fov = $state<number>(75);
  enableDamping = $state<boolean>(true);

  // Internal loop state
  private animationFrameId: number = 0;
  private lastFrameTime = 0;
  private lastNavTime = performance.now();
  private hasShownWindow = false;
  private resizeObserver: ResizeObserver | null = null;
  public keysPressed = new Set<string>();
  public showExportModal = $state(false);

  constructor() {
    this.clock = new THREE.Clock();
  }

  public init(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1e1e1e);

    const w = this.canvas?.clientWidth || 800;
    const h = this.canvas?.clientHeight || 600;
    const aspect = w / h;
    this.camera = new THREE.PerspectiveCamera(this.fov, aspect, 0.1, 1000);
    this.camera.position.z = 3;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
    });
    this.renderer.setSize(w, h, false);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = this.enableDamping;
    this.controls.dampingFactor = 0.05;

    // Patch controls to handle invert settings reactively
    const rawControls = this.controls as any;
    if (rawControls._rotateLeft && rawControls._rotateUp) {
      const orig_rotateLeft = rawControls._rotateLeft.bind(rawControls);
      const orig_rotateUp = rawControls._rotateUp.bind(rawControls);
      rawControls._rotateLeft = (angle: number) => {
        orig_rotateLeft(controlsState.invertMouseX ? -angle : angle);
      };
      rawControls._rotateUp = (angle: number) => {
        orig_rotateUp(controlsState.invertMouseY ? -angle : angle);
      };
    }

    this.gridHelper = new THREE.GridHelper(100, 100, 0x888888, 0x444444);
    this.gridHelper.visible = this.showGrid;
    this.scene.add(this.gridHelper);

    this.stats = new Stats();
    this.stats.dom.style.position = "absolute";
    this.stats.dom.style.top = "10px";
    this.stats.dom.style.right = "10px";
    this.stats.dom.style.left = "auto";
    if (this.canvas && this.canvas?.parentElement) {
      this.canvas?.parentElement.appendChild(this.stats.dom);
    }

    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    this.scene.add(this.ambientLight);

    this.dirLight = new THREE.DirectionalLight(0xffffff, 2.0);
    this.dirLight.position.set(5, 10, 7);
    this.dirLight.castShadow = true;
    this.dirLight.shadow.mapSize.width = 2048;
    this.dirLight.shadow.mapSize.height = 2048;
    this.dirLight.shadow.bias = -0.0001;
    this.scene.add(this.dirLight);

    this.resizeObserver = new ResizeObserver(() => {
      if (!this.canvas) return;
      const width = this.canvas?.parentElement?.clientWidth || this.canvas?.clientWidth || 800;
      const height = this.canvas?.parentElement?.clientHeight || this.canvas?.clientHeight || 600;

      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    });

    if (this.canvas?.parentElement) {
      this.resizeObserver.observe(this.canvas?.parentElement);
    }

    this.animate();
  }

  private animate = (time: DOMHighResTimeStamp = 0) => {
    this.animationFrameId = requestAnimationFrame(this.animate);

    if (this.showExportModal) {
      this.lastFrameTime = time;
      this.lastNavTime = performance.now();
      return;
    }

    if (viewerSettings.maxFps > 0 && time > 0) {
      const interval = 1000 / viewerSettings.maxFps;
      const elapsed = time - this.lastFrameTime;

      if (elapsed < interval) return;
      this.lastFrameTime = time - (elapsed % interval);
    } else if (viewerSettings.maxFps === 0) {
      this.lastFrameTime = time;
    }

    if (this.mixer && !this.isDraggingAnim) {
      const delta = this.clock.getDelta();
      if (this.isPlayingAnim) {
        this.mixer.update(delta);

        this.animationProgress += delta;
        if (this.animationProgress > this.animationDuration) {
          this.animationProgress %= this.animationDuration;
        }
      }
    } else if (this.mixer) {
      this.clock.getDelta();
    }

    if (this.keysPressed.size > 0 && this.camera && this.controls) {
      const currentNavTime = performance.now();
      const navDt = Math.min((currentNavTime - this.lastNavTime) / 1000, 0.1);
      const baseSpeed = Math.max(1.0, this.sceneSize * 0.5) * navDt;
      const speed = baseSpeed * controlsState.moveSpeedFactor;
      const turnSpeed = 1.5 * navDt;

      let moved = false;
      const forward = new THREE.Vector3();
      this.camera.getWorldDirection(forward);
      const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize();

      if (this.keysPressed.has(controlsState.keybindings.forward)) {
        this.camera.position.addScaledVector(forward, speed);
        this.controls.target.addScaledVector(forward, speed);
        moved = true;
      }
      if (this.keysPressed.has(controlsState.keybindings.backward)) {
        this.camera.position.addScaledVector(forward, -speed);
        this.controls.target.addScaledVector(forward, -speed);
        moved = true;
      }
      if (this.keysPressed.has(controlsState.keybindings.left)) {
        this.camera.position.addScaledVector(right, -speed);
        this.controls.target.addScaledVector(right, -speed);
        moved = true;
      }
      if (this.keysPressed.has(controlsState.keybindings.right)) {
        this.camera.position.addScaledVector(right, speed);
        this.controls.target.addScaledVector(right, speed);
        moved = true;
      }
      if (this.keysPressed.has(controlsState.keybindings.up)) {
        this.camera.position.addScaledVector(this.camera.up, speed);
        this.controls.target.addScaledVector(this.camera.up, speed);
        moved = true;
      }
      if (this.keysPressed.has(controlsState.keybindings.down)) {
        this.camera.position.addScaledVector(this.camera.up, -speed);
        this.controls.target.addScaledVector(this.camera.up, -speed);
        moved = true;
      }

      if (this.keysPressed.has(controlsState.keybindings.turnLeft)) {
        forward.applyAxisAngle(this.camera.up, turnSpeed);
        this.controls.target
          .copy(this.camera.position)
          .add(
            forward
              .clone()
              .multiplyScalar(Math.max(1.0, this.camera.position.distanceTo(this.controls.target))),
          );
        moved = true;
      }
      if (this.keysPressed.has(controlsState.keybindings.turnRight)) {
        forward.applyAxisAngle(this.camera.up, -turnSpeed);
        this.controls.target
          .copy(this.camera.position)
          .add(
            forward
              .clone()
              .multiplyScalar(Math.max(1.0, this.camera.position.distanceTo(this.controls.target))),
          );
        moved = true;
      }
      if (moved) this.camera.updateProjectionMatrix();
    }
    this.lastNavTime = performance.now();

    if (this.controls) this.controls.update();
    if (this.stats) this.stats.update();
    if (this.showBoundingBox && this.loadedGroup) {
      this.sceneBox.setFromObject(this.loadedGroup, true);
    }
    if (this.selectedNode && this.selectionHelper) {
      this.selectionHelper.box.setFromObject(this.selectedNode, true);
    }

    const renderCam =
      this.activeCameraIndex >= 0 && this.usdCameras[this.activeCameraIndex]
        ? this.usdCameras[this.activeCameraIndex]
        : this.camera;

    if (this.activeCameraIndex >= 0 && this.usdCameras[this.activeCameraIndex]) {
      const c = this.usdCameras[this.activeCameraIndex] as THREE.PerspectiveCamera;

      if (c.aspect !== undefined) {
        const width = this.canvas?.parentElement?.clientWidth || this.canvas?.clientWidth;
        const height = this.canvas?.parentElement?.clientHeight || this.canvas?.clientHeight;
        if (width !== undefined && height !== undefined) c.aspect = width / height;
        c.updateProjectionMatrix();
      }
    }

    if (!this.scene) return;
    this.renderer.render(this.scene, renderCam as THREE.Camera);

    if (!this.hasShownWindow) {
      this.hasShownWindow = true;
      getCurrentWindow()
        .show()
        .catch((err) => console.error("Could not show window", err));
    }
  };

  public dispose() {
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
    if (this.renderer) this.renderer.dispose();
    if (this.resizeObserver) this.resizeObserver.disconnect();
  }

  public resetCameraView() {
    if (!this.camera || !this.controls || !this.sceneSize) return;

    this.controls.reset();

    this.fov = 75;
    this.camera.fov = this.fov;
    localStorage.setItem("cameraFov", "75");

    this.camera.updateProjectionMatrix();
    this.controls.update();
  }
}
