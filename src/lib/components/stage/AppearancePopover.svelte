<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { stageState } from "$lib/stage/stageState.svelte";
  import { applyToBranch, branchSummary } from "$lib/stage/appearance";
  import { collectSubtreeGprims, type SubtreeGprims } from "$lib/stage/treeUtils";
  import type { MaterialInfo, PrimDetails, ValuePayload } from "$lib/stage/types";
  import Icon from "$lib/components/icons/Icon.svelte";
  import AttributeEditor from "./AttributeEditor.svelte";

  // Anchored appearance popover for one prim-tree row (Task 8). Every
  // commit goes through the shared stageState wrappers — the same authoring
  // route as the PropertyInspector; the "whole branch" checkbox loops the
  // subtree gprims one prim at a time.
  let { primPath, anchor, onClose }: { primPath: string; anchor: HTMLElement; onClose: () => void } =
    $props();

  let popoverEl = $state<HTMLElement | null>(null);
  let details = $state<PrimDetails | null>(null);
  let material = $state<MaterialInfo | null>(null);
  let branch = $state(false);
  let textureDraft = $state("");
  let message = $state<string | null>(null);
  let pos = $state({ left: 0, top: 0 });

  const primName = $derived(primPath.split("/").pop() ?? "");
  // get_material_data answers the prim's own name with a null surface when
  // nothing is bound; a bound material wins over displayColor in the
  // viewport, so the color editor hides while one is bound.
  const boundMaterial = $derived(
    material !== null && (material.surface !== null || material.name !== primName),
  );
  const displayColorAttr = $derived(
    details?.attributes.find((attr) => attr.name === "primvars:displayColor") ?? null,
  );
  const displayColor = $derived(
    displayColorAttr?.value ?? { type: "color3f_array", data: [[0.5, 0.5, 0.5]] },
  );
  // Uniform attributes author their default, never a time sample — the
  // same rule the PropertyInspector applies.
  const colorTime = $derived(displayColorAttr?.variability === "uniform" ? null : undefined);
  const currentTexture = $derived(
    material?.surface?.textures.find((input) => input.input === "diffuseColor")?.file_path ?? null,
  );
  const visibility = $derived(
    (details?.metadata.find(([field]) => field === "visibility")?.[1].data as string) === "invisible"
      ? "invisible"
      : "inherited",
  );

  async function refresh() {
    [details, material] = await Promise.all([
      stageState.fetchPrimDetails(primPath),
      stageState.getMaterialInfo(primPath),
    ]);
  }

  $effect(() => {
    void refresh();
  });

  $effect(() => {
    const rect = anchor.getBoundingClientRect();
    pos = {
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 300)),
      top: Math.min(rect.bottom + 4, window.innerHeight - 260),
    };
  });

  $effect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      // Clicks on the anchor button toggle through its own handler.
      if (popoverEl?.contains(target) || anchor.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  });

  // One commit per target prim: the row itself, or (branch checked) each
  // subtree gprim in turn. Instance prims are rejected by the backend edit
  // arms, so the collector reports them and the loop never attempts them.
  async function commitEach(commit: (path: string) => Promise<string | null>): Promise<string | null> {
    if (!branch) {
      const error = await commit(primPath);
      if (error === null) await refresh();
      return error;
    }
    const subtree: SubtreeGprims = collectSubtreeGprims(stageState.tree, primPath);
    const result = await applyToBranch(commit, subtree.paths);
    message = branchSummary(result, subtree.skippedInstances);
    if (result.failed === 0) await refresh();
    return null;
  }

  async function applyColor(value: ValuePayload): Promise<string | null> {
    const stageId = stageState.activeStageId;
    return commitEach((path) =>
      stageState.setAttributeValue("primvars:displayColor", value, colorTime, path, stageId),
    );
  }

  async function applyTexture(texture: string | null): Promise<string | null> {
    const stageId = stageState.activeStageId;
    const error = await commitEach((path) => stageState.setPrimTexture(path, texture, stageId));
    if (error !== null) message = error;
    return null;
  }

  async function pickTexture() {
    const picked = await open({
      multiple: false,
      title: "Choose a texture image",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "tiff", "exr", "hdr"] }],
    });
    const file = Array.isArray(picked) ? picked[0] : picked;
    if (file) await applyTexture(file);
  }

  async function bindDraftTexture() {
    const texture = textureDraft.trim();
    if (texture) await applyTexture(texture);
  }

  async function toggleVisibility() {
    const stageId = stageState.activeStageId;
    const next = visibility === "invisible" ? "inherited" : "invisible";
    const error = await commitEach((path) =>
      stageState.setPrimMetadata("visibility", { type: "token", data: next }, path, stageId),
    );
    if (error !== null) message = error;
  }
</script>

<div
  class="appearance-popover"
  bind:this={popoverEl}
  style="left: {pos.left}px; top: {pos.top}px;"
  role="dialog"
  aria-label="Appearance"
>
  <div class="popover-header">
    <span class="popover-path" title={primPath}>{primPath}</span>
    <button class="popover-close" title="Close" onclick={onClose}>
      <Icon name="x" size={13} />
    </button>
  </div>

  <div class="popover-section">
    <span class="popover-label">Color</span>
    {#if boundMaterial}
      <span class="popover-note" title="A bound material wins over displayColor in the viewport">
        Bound material "{material?.name}" drives the color; remove the texture binding to author displayColor.
      </span>
    {:else}
      <AttributeEditor value={displayColor} oncommit={applyColor} />
    {/if}
  </div>

  <div class="popover-section">
    <span class="popover-label">Texture</span>
    {#if currentTexture}
      <span class="popover-note" title={currentTexture}>{currentTexture}</span>
    {/if}
    <div class="popover-row">
      <button class="action-btn" onclick={pickTexture}>Choose texture...</button>
      <button
        class="action-btn popover-clear-texture"
        title="Clear the texture binding (the material prims stay)"
        onclick={() => applyTexture(null)}
      >
        <Icon name="x" size={12} /> Remove
      </button>
    </div>
    <div class="popover-row">
      <input
        class="popover-texture-input"
        type="text"
        placeholder="or type a texture file path"
        bind:value={textureDraft}
      />
      <button class="action-btn" onclick={bindDraftTexture}>Bind</button>
    </div>
  </div>

  <div class="popover-section">
    <span class="popover-label">Visibility</span>
    <div class="popover-row">
      <Icon name={visibility === "invisible" ? "eye-off" : "eye"} size={14} />
      <span class="popover-note">{visibility === "invisible" ? "invisible (authored)" : "inherited"}</span>
      <button class="action-btn popover-visibility" onclick={toggleVisibility}>
        {visibility === "invisible" ? "Make visible" : "Make invisible"}
      </button>
    </div>
  </div>

  <label class="popover-branch-row">
    <input class="popover-branch" type="checkbox" bind:checked={branch} />
    Apply to whole branch
  </label>

  {#if message}
    <div class="popover-message" title={message}>{message}</div>
  {/if}
</div>
