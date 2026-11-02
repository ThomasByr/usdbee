<script lang="ts">
  import { stageState } from "$lib/stage/stageState.svelte";
  import { formatValue } from "$lib/stage/valueFormat";
  import AttributeEditor from "./AttributeEditor.svelte";
  import TransformEditor from "./TransformEditor.svelte";

  let open = $state(true);
  // Backend errors per variant-set name (cleared when a new selection is
  // attempted); the kind editor reuses AttributeEditor's own error span.
  let variantErrors = $state<Record<string, string | null>>({});

  const details = $derived(stageState.details);

  // Review fix: errors from a previous selection must not survive a prim
  // switch — clear the per-set error map whenever the details path moves.
  $effect(() => {
    const _path = details?.path;
    variantErrors = {};
  });

  const localTransform = $derived(
    details?.local_transform ? formatValue({ type: "matrix4d", data: details.local_transform }) : null,
  );
  const worldTransform = $derived(
    details?.world_transform ? formatValue({ type: "matrix4d", data: details.world_transform }) : null,
  );
</script>

{#if stageState.status === "ready"}
  <div class="inspector-panel">
    <button class="inspector-toggle" onclick={() => (open = !open)} title={open ? "Collapse" : "Expand"}>
      <span class="toggle-btn expand-btn">{open ? "▼" : "▶"}</span>
      <span class="inspector-title">Inspector</span>
    </button>

    {#if open}
      {#if details}
        <div class="inspector-body">
          <div class="inspector-path" title={details.path}>{details.path}</div>
          <div class="inspector-badges">
            {#if details.type_name}
              <span class="badge badge-type">{details.type_name}</span>
            {/if}
            {#if details.kind}
              <span class="badge badge-kind">{details.kind}</span>
            {/if}
            <span class="badge" class:badge-off={!details.is_active}>
              {details.is_active ? "active" : "inactive"}
            </span>
            {#if details.is_instance}
              <span class="badge badge-instance" title={details.instance_of ?? ""}
                >instance{details.instance_of ? ` of ${details.instance_of}` : ""}</span
              >
            {/if}
            {#if details.is_abstract}
              <span class="badge badge-off">abstract</span>
            {/if}
          </div>

          {#if localTransform !== null || worldTransform !== null}
            <div class="inspector-section">
              <h4>Transform</h4>
              <div class="transform-grid">
                {#if localTransform !== null}
                  <div class="transform-block">
                    <span class="transform-label">Local</span>
                    <pre class="matrix-view">{localTransform}</pre>
                  </div>
                {/if}
                {#if worldTransform !== null}
                  <div class="transform-block">
                    <span class="transform-label">World</span>
                    <pre class="matrix-view">{worldTransform}</pre>
                  </div>
                {/if}
              </div>
            </div>
          {/if}

          <TransformEditor attributes={details.attributes} />

          {#if details.attributes.length > 0}
            <div class="inspector-section">
              <h4>Attributes</h4>
              {#each details.attributes as attr (attr.name)}
                <div class="attr-row">
                  <span class="attr-name" class:fallback={!attr.authored}>{attr.name}</span>
                  <span class="attr-type">{attr.type_name}&thinsp;·&thinsp;{attr.variability}</span>
                  <span class="attr-value" class:fallback={!attr.authored}>
                    <AttributeEditor
                      value={attr.value}
                      oncommit={(value) => stageState.setAttributeValue(attr.name, value)}
                    />
                  </span>
                </div>
              {/each}
            </div>
          {/if}

          <div class="inspector-section">
            <h4>Metadata</h4>
            <div class="attr-row">
              <span class="attr-name">kind</span>
              <span class="attr-value">
                <AttributeEditor
                  value={{ type: "token", data: details.kind }}
                  oncommit={(v) => stageState.setPrimMetadata("kind", v)}
                />
              </span>
            </div>
            {#each details.metadata as [field, value] (field)}
              <div class="attr-row">
                <span class="attr-name">{field}</span>
                <span class="attr-value">
                  <AttributeEditor {value} oncommit={(v) => stageState.setPrimMetadata(field, v)} />
                </span>
              </div>
            {/each}
          </div>

          {#if details.variant_sets.length > 0}
            <div class="inspector-section">
              <h4>Variant Sets</h4>
              {#each details.variant_sets as set (set.name)}
                <div class="variant-set">
                  <span class="attr-name">{set.name}</span>
                  <span class="variant-options">
                    <select
                      class="variant-select"
                      title="authored selection: {set.authored_selection ?? 'none'}"
                      value={set.authored_selection ?? ""}
                      onchange={async (event) => {
                        const select = event.currentTarget;
                        const selection = select.value || null;
                        variantErrors[set.name] = null;
                        variantErrors[set.name] = await stageState.setVariantSelection(set.name, selection);
                        // Review fix: a failed commit must not leave the
                        // uncommitted selection shown — reset the DOM value
                        // to what the stage still authors.
                        if (variantErrors[set.name] !== null) {
                          select.value = set.authored_selection ?? "";
                        }
                      }}
                    >
                      <!-- The empty option clears the local selection; weaker
                        layer opinions compose again. -->
                      <option value="">(none)</option>
                      {#each set.options as option (option)}
                        <option value={option}>{option}</option>
                      {/each}
                    </select>
                    {#if variantErrors[set.name]}
                      <span class="variant-error" title={variantErrors[set.name]}>
                        {variantErrors[set.name]}
                      </span>
                    {/if}
                  </span>
                </div>
              {/each}
            </div>
          {/if}

          {#if details.composition_arcs.length > 0}
            <div class="inspector-section">
              <h4>Composition Arcs</h4>
              {#each details.composition_arcs as arc (arc)}
                <div class="arc-row">{arc}</div>
              {/each}
            </div>
          {/if}
        </div>
      {:else if stageState.selectedPath}
        <div class="inspector-empty">Failed to load details for {stageState.selectedPath}.</div>
      {:else}
        <div class="inspector-empty">Select a prim to inspect.</div>
      {/if}
    {/if}
  </div>
{/if}
