<script lang="ts">
  import { onMount } from "svelte";
  import { getVersion } from "@tauri-apps/api/app";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import Modal from "$lib/components/Modal.svelte";
  import { updateState, checkForUpdates, installUpdate } from "$lib/state/updateState.svelte";

  let { onClose }: { onClose: () => void } = $props();

  const LICENSE_URL = "https://github.com/ThomasByr/usdbee/blob/main/LICENSE";
  const REPOSITORY_URL = "https://github.com/ThomasByr/usdbee";
  // The Windows note is about the installer form, which only Windows has.
  const isWindows = navigator.userAgent.includes("Windows");

  let version = $state("");

  onMount(() => {
    void getVersion()
      .then((v) => (version = v))
      .catch(() => (version = "unknown"));
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
          ? `Version ${updateState.version} is available. This installs usdbee as an installed app; the portable executable you are running stays as-is.`
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

<Modal title="About usdbee" contentClass="about-modal" {onClose}>
  <div class="about-row">
    <span class="about-label">version</span>
    <span class="about-value">{version || "..."}</span>
  </div>
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
