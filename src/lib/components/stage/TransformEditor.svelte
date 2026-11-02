<script lang="ts">
  import { stageState } from "$lib/stage/stageState.svelte";
  import type { AttributeInfo } from "$lib/stage/types";

  // Numeric transform-op editors (Phase 3, Task 4): per-axis fields for
  // the authored triplet ops the gizmo also authors (translate, rotateXYZ
  // degrees, scale). Commit contract mirrors AttributeEditor: Enter/blur
  // commit, failed commits keep the draft, a failed or successful Enter
  // commit swallows the immediate follow-up blur.
  let { attributes }: { attributes: AttributeInfo[] } = $props();

  const EDITABLE_OPS = ["xformOp:translate", "xformOp:rotateXYZ", "xformOp:scale"] as const;

  // Only ops the prim's xformOpOrder actually lists take effect in the
  // composed transform; an authored-but-not-in-order op would commit with
  // no visible change, so it gets no editor row.
  const order = $derived.by(() => {
    const attr = attributes.find((a) => a.name === "xformOpOrder");
    return attr && Array.isArray(attr.value.data) ? (attr.value.data as string[]) : null;
  });

  const ops = $derived(
    order === null
      ? []
      : EDITABLE_OPS.map((name) => attributes.find((a) => a.name === name)).filter(
          (a): a is AttributeInfo =>
            !!a &&
            order.includes(a.name) &&
            Array.isArray(a.value.data) &&
            a.value.data.length === 3 &&
            a.value.data.every((v) => typeof v === "number"),
        ),
  );

  let drafts = $state<Record<string, [string, string, string]>>({});
  let errors = $state<Record<string, string | null>>({});
  let suppressNextBlur = $state<Record<string, boolean>>({});

  // Sync drafts on every details refresh (a successful commit refreshes
  // details and rewrites all three fields; a failed one keeps the draft).
  $effect(() => {
    for (const op of ops) {
      drafts[op.name] = (op.value.data as number[]).map(String) as [string, string, string];
      errors[op.name] = null;
    }
  });

  // The declared spelling the backend validates against; undeclared custom
  // ops fall back to the payload's vec family.
  function payloadType(op: AttributeInfo): string {
    if (op.type_name) return op.type_name;
    return op.value.type === "vec3d" ? "double3" : "float3";
  }

  function setDraft(op: AttributeInfo, axis: number, text: string) {
    const draft = drafts[op.name] ?? ["", "", ""];
    draft[axis] = text;
    drafts[op.name] = draft;
  }

  async function commit(op: AttributeInfo, axis: 0 | 1 | 2, fromBlur: boolean) {
    if (fromBlur && suppressNextBlur[op.name]) {
      suppressNextBlur[op.name] = false;
      return;
    }
    const current = op.value.data as number[];
    const text = (drafts[op.name]?.[axis] ?? "").trim();
    const n = Number(text);
    if (!Number.isFinite(n)) {
      errors[op.name] = `"${text}" is not a number`;
      suppressNextBlur[op.name] = true;
      return;
    }
    const data = [...current];
    data[axis] = n;
    if (data.every((v, i) => v === current[i])) {
      errors[op.name] = null;
      return;
    }
    errors[op.name] = await stageState.setAttributeValue(op.name, {
      type: payloadType(op),
      data,
    });
    if (!fromBlur || errors[op.name] !== null) suppressNextBlur[op.name] = true;
  }
</script>

{#if ops.length > 0}
  <div class="inspector-section">
    <h4>Transform Ops</h4>
    {#each ops as op (op.name)}
      <div class="transform-op-row">
        <span class="transform-op-name" title="{op.type_name} · degrees for rotateXYZ"
          >{op.name.replace("xformOp:", "")}</span
        >
        <span class="transform-fields">
          {#each ["X", "Y", "Z"] as label, axis (label)}
            <input
              class="transform-input"
              class:value-error={errors[op.name] != null}
              type="text"
              inputmode="decimal"
              value={drafts[op.name]?.[axis] ?? ""}
              title="{op.name}.{label}"
              onfocus={() => (suppressNextBlur[op.name] = false)}
              oninput={(event) => setDraft(op, axis, event.currentTarget.value)}
              onkeydown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void commit(op, axis as 0 | 1 | 2, false);
                }
              }}
              onblur={() => void commit(op, axis as 0 | 1 | 2, true)}
            />
          {/each}
          {#if errors[op.name]}<span class="transform-error" title={errors[op.name]}>!</span>{/if}
        </span>
      </div>
    {/each}
  </div>
{/if}

<style>
  .transform-op-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.1rem 0;
    font-size: 0.8rem;
  }

  .transform-op-name {
    flex: 1;
    color: #b8c0cc;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .transform-fields {
    display: inline-flex;
    gap: 0.25rem;
    align-items: center;
  }

  .transform-input {
    width: 4rem;
    padding: 0.1rem 0.25rem;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.05);
    color: inherit;
    font: inherit;
    font-size: 0.78rem;
  }

  .transform-input:focus {
    outline: none;
    border-color: rgba(120, 170, 255, 0.7);
  }

  .transform-input.value-error {
    border-color: rgba(255, 100, 100, 0.8);
  }

  .transform-error {
    color: #ff8080;
    font-size: 0.75rem;
  }
</style>
