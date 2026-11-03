// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, unmount, tick } from "svelte";
import type { PrimNode } from "$lib/stage/types";
import PrimTree from "./PrimTree.svelte";

const mocks = vi.hoisted(() => ({
  selectPrim: vi.fn(),
  fetchPrimDetails: vi.fn(),
  setPrimMetadata: vi.fn().mockResolvedValue(null),
  tree: [] as PrimNode[],
}));

vi.mock("$lib/stage/stageState.svelte", () => ({
  stageState: {
    selectPrim: mocks.selectPrim,
    fetchPrimDetails: mocks.fetchPrimDetails,
    setPrimMetadata: mocks.setPrimMetadata,
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

const leaf = (path: string, name: string, type_name = "Mesh"): PrimNode => ({
  path,
  name,
  type_name,
  kind: "",
  is_active: true,
  is_instance: false,
  is_abstract: false,
  children: [],
});

let instance: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  mocks.selectPrim.mockReset();
  mocks.fetchPrimDetails.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  if (instance !== null) unmount(instance);
  instance = null;
  document.body.innerHTML = "";
});

const rowPaths = (): string[] =>
  [...document.querySelectorAll(".node-type")].map((el) => el.getAttribute("title") ?? "");

async function mountTree(tree: PrimNode[]) {
  mocks.tree = tree;
  instance = mount(PrimTree, { target: document.body, props: {} });
  await tick();
}

describe("PrimTree windowed rendering", () => {
  it("mounts only a bounded slice of a large flat tree", async () => {
    const flat = Array.from({ length: 3000 }, (_, i) => leaf(`/N${i}`, `N${i}`));
    await mountTree(flat);

    const mounted = document.querySelectorAll(".tree-node-label");
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(100);
    expect(rowPaths()[0]).toBe("/N0");
    expect(rowPaths()).not.toContain("/N500");
  });

  it("expands a subtree on toggle and collapses it again", async () => {
    const tree: PrimNode[] = [
      {
        ...leaf("/Root", "Root", "Xform"),
        children: [leaf("/Root/Child", "Child"), leaf("/Root/Grand", "Grand")],
      },
    ];
    await mountTree(tree);

    expect(rowPaths()).toEqual(["/Root"]);
    document.querySelector<HTMLButtonElement>(".expand-btn")!.click();
    await tick();
    expect(rowPaths()).toEqual(["/Root", "/Root/Child", "/Root/Grand"]);
    document.querySelector<HTMLButtonElement>(".expand-btn")!.click();
    await tick();
    expect(rowPaths()).toEqual(["/Root"]);
  });

  it("selects a prim when its row is clicked", async () => {
    await mountTree([leaf("/Root", "Root", "Xform")]);

    (document.querySelector(".tree-node-label") as HTMLElement).click();
    await tick();

    expect(mocks.selectPrim).toHaveBeenCalledWith("/Root");
  });
});
