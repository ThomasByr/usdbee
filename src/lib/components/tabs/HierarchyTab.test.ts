// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import * as THREE from "three";
import { buildScene } from "$lib/render/sceneBuilder";
import type { PrimNode, RenderNode } from "$lib/stage/types";
import HierarchyTab from "./HierarchyTab.svelte";

const mocks = vi.hoisted(() => ({
  selectPrim: vi.fn(),
  ensureTree: vi.fn(),
  tree: [] as PrimNode[],
}));

vi.mock("$lib/stage/stageState.svelte", () => ({
  stageState: {
    selectPrim: mocks.selectPrim,
    ensureTree: mocks.ensureTree,
    fetchPrimDetails: vi.fn(),
    setPrimMetadata: vi.fn(),
    get tree() {
      return mocks.tree;
    },
    get status() {
      return "ready";
    },
    get selectedPath() {
      return null;
    },
    get details() {
      return null;
    },
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("$lib/components/stage/PropertyInspector.svelte", () => import("./__tests__/inspector-mock.svelte"));

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function node(overrides: Partial<RenderNode>): RenderNode {
  return {
    path: "/World",
    name: "World",
    type_name: "Xform",
    has_geometry: false,
    animated: false,
    geometry_animated: false,
    material: null,
    double_sided: false,
    instances: [],
    transform: IDENTITY,
    visible: true,
    children: [],
    ...overrides,
  };
}

function packedTriangle(): ArrayBuffer {
  const buffer = new ArrayBuffer(20 + 9 * 4 + 3 * 4);
  const view = new DataView(buffer);
  view.setUint32(0, 0x55534442, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, 3, true);
  view.setUint32(12, 3, true);
  view.setUint32(16, 0, true);
  new Float32Array(buffer, 20, 9).set([-1, 0, 0, 1, 0, 0, 0, 1, 0]);
  new Uint32Array(buffer, 56, 3).set([0, 1, 2]);
  return buffer;
}

const mesh = node({ path: "/World/PlasticBall", name: "PlasticBall", type_name: "Mesh", has_geometry: true });
const material = node({
  path: "/World/Looks/Plastic",
  name: "Plastic",
  type_name: "Material",
});
const manifest = [
  node({
    children: [mesh, node({ path: "/World/Looks", name: "Looks", type_name: "Scope", children: [material] })],
  }),
];
function prim(path: string, name: string, typeName: string, children: PrimNode[] = []): PrimNode {
  return {
    path,
    name,
    type_name: typeName,
    kind: "",
    is_active: true,
    is_instance: false,
    is_abstract: false,
    children,
  };
}
const tree = [
  prim("/World", "World", "Xform", [
    prim(mesh.path, mesh.name, mesh.type_name),
    prim("/World/Looks", "Looks", "Scope", [prim(material.path, material.name, material.type_name)]),
  ]),
];

let instance: ReturnType<typeof mount> | null = null;
let viewer: any;

beforeEach(async () => {
  mocks.tree = tree;
  const loadedGroup = await buildScene(manifest, {
    getGeometry: async () => packedTriangle(),
    getMaterial: async () => ({ name: "Plastic", surface: null }),
    loadTexture: async () => new THREE.Texture(),
  });
  const scene = new THREE.Scene();
  scene.add(loadedGroup);
  viewer = { scene, loadedGroup, selectedNode: null, selectionHelper: null };
  instance = mount(HierarchyTab, { target: document.body, props: { viewer } });
  await tick();
  ([...document.querySelectorAll("button")] as HTMLButtonElement[])
    .find((button) => button.textContent === "Expand All")
    ?.click();
  await tick();
});

afterEach(() => {
  if (instance !== null) unmount(instance);
  instance = null;
  document.body.innerHTML = "";
});

async function select(path: string) {
  (document.querySelector(`.node-name[title="${path}"]`)!.parentElement as HTMLElement).click();
  await tick();
}

describe("HierarchyTab selection bounds", () => {
  it("does not render the default two-unit Box3Helper for an empty prim", async () => {
    await select("/World/Looks/Plastic");

    expect(viewer.selectionHelper.box.isEmpty()).toBe(true);
    expect(viewer.selectionHelper.visible).toBe(false);
  });

  it("keeps a mesh selection visible with tight bounds", async () => {
    await select("/World/PlasticBall");

    expect(viewer.selectionHelper.visible).toBe(true);
    expect(viewer.selectionHelper.box.min.toArray()).toEqual([-1, 0, 0]);
    expect(viewer.selectionHelper.box.max.toArray()).toEqual([1, 1, 0]);
  });
});
