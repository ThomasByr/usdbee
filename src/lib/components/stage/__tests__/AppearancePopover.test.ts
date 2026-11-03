// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, unmount, tick } from "svelte";
import type { PrimDetails } from "$lib/stage/types";
import AppearancePopover from "../AppearancePopover.svelte";

const mocks = vi.hoisted(() => ({
  fetchPrimDetails: vi.fn(),
  getMaterialInfo: vi.fn(),
  setAttributeValue: vi.fn(),
  setPrimMetadata: vi.fn(),
  setPrimTexture: vi.fn(),
  tree: [] as unknown[],
  activeStageId: 1,
}));

vi.mock("$lib/stage/stageState.svelte", () => ({
  stageState: {
    fetchPrimDetails: mocks.fetchPrimDetails,
    getMaterialInfo: mocks.getMaterialInfo,
    setAttributeValue: mocks.setAttributeValue,
    setPrimMetadata: mocks.setPrimMetadata,
    setPrimTexture: mocks.setPrimTexture,
    get tree() {
      return mocks.tree;
    },
    get activeStageId() {
      return mocks.activeStageId;
    },
  },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const mesh = (path: string, name: string, extra: Record<string, unknown> = {}) => ({
  path,
  name,
  type_name: "Mesh",
  kind: "",
  is_active: true,
  is_instance: false,
  is_abstract: false,
  children: [],
  ...extra,
});

const details = (over: Partial<PrimDetails> = {}): PrimDetails =>
  ({
    path: "/World/Ball",
    type_name: "Mesh",
    kind: "",
    is_active: true,
    is_instance: false,
    is_abstract: false,
    instance_of: null,
    attributes: [
      {
        name: "primvars:displayColor",
        type_name: "Color3fArray",
        variability: "vertex",
        authored: true,
        value: { type: "color3f_array", data: [[0.5, 0.5, 0.5]] },
      },
    ],
    metadata: [],
    variant_sets: [],
    composition_arcs: [],
    local_transform: null,
    world_transform: null,
    ...over,
  }) as PrimDetails;

const unbound = { name: "Ball", surface: null };

let instance: ReturnType<typeof mount> | null = null;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mocks.fetchPrimDetails.mockReset().mockResolvedValue(details());
  mocks.getMaterialInfo.mockReset().mockResolvedValue(unbound);
  mocks.setAttributeValue.mockReset().mockResolvedValue(null);
  mocks.setPrimMetadata.mockReset().mockResolvedValue(null);
  mocks.setPrimTexture.mockReset().mockResolvedValue(null);
  mocks.tree = [mesh("/World", "World")];
  mocks.activeStageId = 1;
});

afterEach(() => {
  if (instance !== null) unmount(instance);
  instance = null;
  document.body.innerHTML = "";
});

async function mountPopover(primPath = "/World/Ball") {
  const anchor = document.body.appendChild(document.createElement("div"));
  instance = mount(AppearancePopover, {
    target: document.body,
    props: { primPath, anchor, onClose: () => {} },
  });
  await vi.waitFor(() => expect(mocks.fetchPrimDetails).toHaveBeenCalled());
  await tick();
  return instance;
}

const hexInput = (): HTMLInputElement => document.querySelector<HTMLInputElement>("input.value-editor")!;

async function commitHex(hex: string) {
  const input = hexInput();
  input.value = hex;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  // The commit chain (editor -> popover -> branch loop) spans several
  // microtask hops; flush them all before asserting on the rendered state.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
}

const branchCheckbox = (): HTMLInputElement =>
  document.querySelector<HTMLInputElement>("input.popover-branch")!;

describe("AppearancePopover commit wiring", () => {
  it("disables the color editor when the prim has a bound material", async () => {
    mocks.getMaterialInfo.mockResolvedValue({ name: "RedMat", surface: { textures: [] } });
    await mountPopover();

    expect(hexInput()).toBeNull();
    expect(document.body.textContent).toContain("RedMat");
    expect(document.body.textContent).toContain("Bound material");
  });

  it("commits an edited color through the shared attribute wrapper with the prim's path", async () => {
    await mountPopover();
    await commitHex("#ff0000");

    expect(mocks.setAttributeValue).toHaveBeenCalledWith(
      "primvars:displayColor",
      { type: "color3f_array", data: [[1, 0, 0]] },
      undefined,
      "/World/Ball",
      1,
    );
  });

  it("applies a branch color once per subtree gprim", async () => {
    mocks.tree = [
      mesh("/World", "World", {
        type_name: "Xform",
        children: [
          mesh("/World/Ball", "Ball"),
          mesh("/World/Other", "Other"),
          mesh("/World/Group", "Group", {
            type_name: "Xform",
            children: [mesh("/World/Group/Leaf", "Leaf")],
          }),
        ],
      }),
    ];
    mocks.getMaterialInfo.mockResolvedValue({ name: "World", surface: null });
    await mountPopover("/World");
    branchCheckbox().click();
    await tick();
    await commitHex("#00ff00");

    const paths = mocks.setAttributeValue.mock.calls.map((call) => call[3]);
    expect(paths).toEqual(["/World/Ball", "/World/Other", "/World/Group/Leaf"]);
    expect(mocks.setAttributeValue).toHaveBeenCalledWith(
      "primvars:displayColor",
      { type: "color3f_array", data: [[0, 1, 0]] },
      undefined,
      "/World/Ball",
      1,
    );
  });

  it("pins every deferred branch commit to the source stage", async () => {
    mocks.tree = [
      mesh("/World", "World", {
        type_name: "Xform",
        children: [mesh("/World/Ball", "Ball"), mesh("/World/Other", "Other")],
      }),
    ];
    const firstCommit = deferred<string | null>();
    mocks.setAttributeValue.mockImplementationOnce(() => firstCommit.promise);
    mocks.getMaterialInfo.mockResolvedValue({ name: "World", surface: null });
    await mountPopover("/World");
    branchCheckbox().click();
    await tick();

    const input = hexInput();
    input.value = "#00ff00";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(mocks.setAttributeValue).toHaveBeenCalledTimes(1));
    mocks.activeStageId = 2;
    firstCommit.resolve(null);
    await vi.waitFor(() => expect(mocks.setAttributeValue).toHaveBeenCalledTimes(2));

    expect(mocks.setAttributeValue.mock.calls[0][4]).toBe(1);
    expect(mocks.setAttributeValue.mock.calls[1][4]).toBe(1);
  });

  it("continues a branch past a failing prim and summarizes the failures", async () => {
    mocks.tree = [
      mesh("/World", "World", {
        type_name: "Xform",
        children: [mesh("/World/Ball", "Ball"), mesh("/World/Other", "Other")],
      }),
    ];
    mocks.getMaterialInfo.mockResolvedValue({ name: "World", surface: null });
    mocks.setAttributeValue.mockImplementation(
      async (_name: string, _value: unknown, _t: unknown, path: string) =>
        path === "/World/Other" ? "backend refused" : null,
    );
    await mountPopover("/World");
    branchCheckbox().click();
    await tick();
    await commitHex("#00ff00");

    expect(mocks.setAttributeValue).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("1 failed");
    expect(document.body.textContent).toContain("backend refused");
  });

  it("clears the texture binding through the shared texture wrapper", async () => {
    await mountPopover();
    document.querySelector<HTMLButtonElement>("button.popover-clear-texture")!.click();
    await tick();

    expect(mocks.setPrimTexture).toHaveBeenCalledWith("/World/Ball", null, 1);
  });

  it("toggles authored visibility through the shared metadata wrapper", async () => {
    await mountPopover();
    expect(document.body.textContent).toContain("inherited");
    document.querySelector<HTMLButtonElement>("button.popover-visibility")!.click();
    await tick();

    expect(mocks.setPrimMetadata).toHaveBeenCalledWith(
      "visibility",
      { type: "token", data: "invisible" },
      "/World/Ball",
      1,
    );
  });
});
