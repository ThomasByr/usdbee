<script lang="ts">
  import { formatBytes, isTexture } from "$lib/utils/format";

  let {
    rootFile,
    dependencies,
    filteredDependencies,
    filterText = $bindable(),
    openErrorModal,
    replaceWithColor,
  } = $props<{
    rootFile: string | null;
    dependencies: Record<string, any> | null;
    filteredDependencies: [string, any][];
    filterText: string;
    openErrorModal: (msg: string) => void;
    replaceWithColor: (path: string, event: Event) => void;
  }>();
</script>

{#if rootFile}
  <div class="node root">
    <strong>Root:</strong>
    {rootFile.split(/[\\/]/).pop()}
  </div>
{/if}

{#if dependencies}
  <div class="filter-box">
    <input
      type="text"
      bind:value={filterText}
      placeholder="Filter dependencies..."
      class="dependency-filter"
    />
  </div>
  <ul class="tree-list">
    {#each filteredDependencies as [path, info]}
      <li class="node child {info.resolved ? 'resolved' : 'missing'}">
        {#if info.error_msg}
          <button
            class="icon-btn"
            style="flex-shrink: 0;"
            onclick={() => openErrorModal(info.error_msg!)}
            title="View Error Details">🔎</button
          >
        {/if}
        <span
          class="status-dot"
          style={info.fallback_color ? `background-color: ${info.fallback_color};` : ""}
          title={info.fallback_color ? "Fallback Color" : ""}
        ></span>
        <span class="path">{path}</span>
        {#if info.error_msg}
          <div class="error-hint" title={info.error_msg}>(Error)</div>
        {/if}
        {#if info.size_bytes !== null && info.size_bytes !== undefined}
          <span class="size">{formatBytes(info.size_bytes)}</span>
        {:else if isTexture(path)}
          <div class="fallback-action">
            <span class="fallback-label">{info.fallback_color ? "Fallback:" : "Fix:"}</span>
            <input
              type="color"
              value={info.fallback_color || "#ff0000"}
              title={info.fallback_color ? "Change fallback color" : "Replace with uniform color"}
              onchange={(e) => replaceWithColor(path, e)}
            />
          </div>
        {:else}
          <span class="size" style="color: #ff5555;">Broken Ref</span>
        {/if}
      </li>
    {/each}
  </ul>
{/if}
