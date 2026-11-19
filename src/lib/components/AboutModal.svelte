<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { onMount } from "svelte";
  import { getVersion } from "@tauri-apps/api/app";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import Modal from "$lib/components/Modal.svelte";
  import { updateState, checkForUpdates, installUpdate } from "$lib/state/updateState.svelte";

  interface BuildInfo {
    version: string;
    tauri: string;
    openusd: string;
    three_js: string;
    svelte: string;
    profile: string;
    opt_level: string;
    deps_opt_level: string;
    debug_assertions: boolean;
    binary: string;
    resident: string;
    total_ram: string;
  }

  // The compact size (menu "Check for Updates..." and the startup hit) shows
  // the version and the update section only; the full About adds the rest.
  let { onClose, full }: { onClose: () => void; full: boolean } = $props();

  const LICENSE_URL = "https://github.com/ThomasByr/usdbee/blob/main/LICENSE";
  const REPOSITORY_URL = "https://github.com/ThomasByr/usdbee";
  // The Windows note is about the installer form, which only Windows has.
  const isWindows = navigator.userAgent.includes("Windows");

  let version = $state("");
  // Filled once on mount; a failed call hides the build block rather than
  // printing a row of placeholders.
  let build = $state<BuildInfo | null>(null);

  onMount(() => {
    void getVersion()
      .then((v) => (version = v))
      .catch(() => (version = "unknown"));
    // The compact size never renders the build block, so skip the sampling.
    if (!full) return;
    // Memory changes while the dialog is open, so the block refreshes once a
    // second. A failed poll keeps the last good reading instead of blanking.
    const refresh = () => {
      void invoke<BuildInfo>("app_build_info")
        .then((info) => (build = info))
        .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  });

  const busy = $derived(updateState.status === "checking" || updateState.status === "downloading");

  const line = $derived.by(() => {
    switch (updateState.status) {
      case "checking":
        return "Checking...";
      case "up-to-date":
        return "usdbee is up to date.";
      case "available":
        return isWindows
          ? `Version ${updateState.version} is available. The update installs usdbee as an installed app on this system.`
          : `Version ${updateState.version} is available.`;
      case "downloading":
        return `Downloading... ${Math.round(updateState.progress * 100)}%`;
      case "unsupported":
        return "Updates are available for the AppImage build only.";
      case "error":
        return updateState.message;
      default:
        return "Check for a newer version.";
    }
  });

  const action = $derived.by(() => {
    switch (updateState.status) {
      case "checking":
        return "Checking...";
      case "downloading":
        return "Downloading...";
      case "up-to-date":
        return "Check again";
      case "available":
        return "Download & Restart";
      case "error":
        return "Try again";
      default:
        return "Check for Updates";
    }
  });

  function run(): void {
    if (updateState.status === "available") void installUpdate();
    else void checkForUpdates();
  }

  // A link the user cannot open is not worth an error dialog.
  function openLink(url: string): void {
    void openUrl(url).catch(() => {});
  }
</script>

<Modal title={full ? "About usdbee" : "Update usdbee"} contentClass="about-modal" {onClose}>
  <div class="about-row">
    <span class="about-label">version</span>
    <span class="about-value">{version || "..."}</span>
  </div>

  {#if full}
    <div class="about-row">
      <span class="about-label">author</span>
      <span class="about-value">ThomasByr</span>
    </div>
    <div class="about-row">
      <span class="about-label">license</span>
      <button class="about-link" onclick={() => openLink(LICENSE_URL)}>MIT</button>
    </div>
    <div class="about-row">
      <span class="about-label">repository</span>
      <button class="about-link" onclick={() => openLink(REPOSITORY_URL)}>github.com/ThomasByr/usdbee</button>
    </div>

    {#if build}
      <div class="about-section">Build</div>
      <div class="about-row">
        <span class="about-label">tauri</span>
        <span class="about-value">{build.tauri}</span>
      </div>
      <div class="about-row">
        <span class="about-label">openusd binding</span>
        <span class="about-value">{build.openusd}</span>
      </div>
      <div class="about-row">
        <span class="about-label">three.js</span>
        <span class="about-value">{build.three_js}</span>
      </div>
      <div class="about-row">
        <span class="about-label">svelte</span>
        <span class="about-value">{build.svelte}</span>
      </div>
      <div class="about-row">
        <span class="about-label">build</span>
        <span class="about-value"
          >{build.profile}, opt-level {build.opt_level}{build.deps_opt_level
            ? ` (deps: ${build.deps_opt_level})`
            : ""}</span
        >
      </div>
      <div class="about-row">
        <span class="about-label">binary</span>
        <span class="about-value">{build.binary}</span>
      </div>
      <div class="about-row">
        <span class="about-label">memory</span>
        <span class="about-value">{build.resident} of {build.total_ram}</span>
      </div>
    {/if}
  {/if}

  <div class="about-section">Updates</div>
  <p class="about-status">{line}</p>
  {#if updateState.status !== "unsupported"}
    <div class="about-actions">
      <button class="primary-btn" disabled={busy} onclick={run}>{action}</button>
    </div>
  {/if}
</Modal>

<style>
  :global(.about-modal) {
    min-width: 380px;
    max-width: 520px;
  }

  .about-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 6px 0;
    font-size: 12px;
  }

  .about-label {
    flex: 0 0 30%;
    color: var(--text-dim);
  }

  .about-value,
  .about-link {
    flex: 1 1 auto;
    text-align: left;
  }

  .about-link {
    padding: 0;
    border: none;
    background: none;
    color: var(--accent);
    cursor: pointer;
    font-size: 12px;
    text-decoration: underline;
  }

  .about-section {
    margin: 14px 0 4px;
    font-weight: 600;
    font-size: 13px;
  }

  .about-status {
    margin: 4px 0 10px;
    font-size: 12px;
    line-height: 1.4;
  }

  .about-actions {
    display: flex;
    justify-content: flex-end;
  }
</style>
