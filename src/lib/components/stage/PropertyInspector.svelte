<script lang="ts">
  import { stageState } from "$lib/stage/stageState.svelte";
  import { formatValue } from "$lib/stage/valueFormat";
  import ValueView from "./ValueView.svelte";

  let open = $state(true);

  const details = $derived(stageState.details);

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

          {#if details.attributes.length > 0}
            <div class="inspector-section">
              <h4>Attributes</h4>
              {#each details.attributes as attr (attr.name)}
                <div class="attr-row">
                  <span class="attr-name" class:fallback={!attr.authored}>{attr.name}</span>
                  <span class="attr-type">{attr.type_name}&thinsp;·&thinsp;{attr.variability}</span>
                  <span class="attr-value" class:fallback={!attr.authored}>
                    <ValueView value={attr.value} />
                  </span>
                </div>
              {/each}
            </div>
          {/if}

          {#if details.metadata.length > 0}
            <div class="inspector-section">
              <h4>Metadata</h4>
              {#each details.metadata as [field, value] (field)}
                <div class="attr-row">
                  <span class="attr-name">{field}</span>
                  <span class="attr-value"><ValueView {value} /></span>
                </div>
              {/each}
            </div>
          {/if}

          {#if details.variant_sets.length > 0}
            <div class="inspector-section">
              <h4>Variant Sets</h4>
              {#each details.variant_sets as set (set.name)}
                <div class="variant-set">
                  <span class="attr-name">{set.name}</span>
                  <span class="variant-options">
                    {#each set.options as option (option)}
                      <span
                        class="variant-option"
                        class:selected={option === set.authored_selection}
                        title={option === set.authored_selection ? "authored selection" : ""}>{option}</span
                      >
                    {/each}
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
