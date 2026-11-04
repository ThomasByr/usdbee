// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "svelte";
import type { PrimDetails } from "$lib/stage/types";
import PropertyInspector from "../PropertyInspector.svelte";

const mocks = vi.hoisted(() => ({
  setPrimMetadata: vi.fn(),
  details: null as PrimDetails | null,
  status: "ready",
}));

vi.mock("$lib/stage/stageState.svelte", () => ({
  stageState: {
    setPrimMetadata: mocks.setPrimMetadata,
    get details() {
      return mocks.details;
    },
    get status() {
      return mocks.status;
    },
    get selectedPath() {
      return mocks.details?.path ?? null;
    },
  },
}));

const details = (over: Partial<PrimDetails> = {}): PrimDetails =>
  ({
    path: "/World/Ball",
    type_name: "Mesh",
    kind: "component",
    is_active: true,
    is_instance: false,
    is_abstract: false,
    instance_of: null,
    attributes: [],
    metadata: [],
    variant_sets: [],
    composition_arcs: [],
    local_transform: null,
    world_transform: null,
    ...over,
  }) as PrimDetails;

let instance: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  mocks.setPrimMetadata.mockReset().mockResolvedValue(null);
  mocks.details = details();
  mocks.status = "ready";
});

afterEach(() => {
  if (instance !== null) unmount(instance);
  instance = null;
  document.body.innerHTML = "";
});

function mountInspector() {
  instance = mount(PropertyInspector, { target: document.body });
  return instance;
}

// Field names rendered by the Metadata section, in DOM order.
function metadataFields(): string[] {
  const section = [...document.querySelectorAll(".inspector-section")].find(
    (el) => el.querySelector("h4")?.textContent === "Metadata",
  );
  return [...(section?.querySelectorAll(".attr-name") ?? [])].map((el) => el.textContent?.trim() ?? "");
}

describe("PropertyInspector metadata rows", () => {
  it("renders one active and one kind row when details.metadata repeats them", () => {
    // The backend lists authored `active` metadata, so after a metadata edit
    // the payload contains the same field the hard-coded rows already show.
    mocks.details = details({
      metadata: [
        ["active", { type: "bool", data: true }],
        ["kind", { type: "token", data: "component" }],
        ["documentation", { type: "string", data: "a ball" }],
      ],
    });
    mountInspector();

    const fields = metadataFields();
    expect(fields.filter((field) => field === "active")).toHaveLength(1);
    expect(fields.filter((field) => field === "kind")).toHaveLength(1);
  });

  it("still renders the other authored metadata fields", () => {
    mocks.details = details({
      metadata: [
        ["active", { type: "bool", data: true }],
        ["documentation", { type: "string", data: "a ball" }],
        ["hidden", { type: "bool", data: false }],
      ],
    });
    mountInspector();

    expect(metadataFields()).toEqual(["active", "kind", "documentation", "hidden"]);
  });
});
