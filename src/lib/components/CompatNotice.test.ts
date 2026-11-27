// @vitest-environment happy-dom
// The bar mirrors the startup decision: it shows only when the backend turned
// hardware compositing off on its own, and it goes away when the user says so.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import CompatNotice from "./CompatNotice.svelte";
import { compatState, type CompatReport } from "$lib/state/compatState.svelte";

const report: CompatReport = {
  mode: "auto",
  applied: true,
  forced: false,
  reason: "WebKitGTK fence leak on NVIDIA + X11",
  distro_label: "Debian 13",
  nvidia_version: "550.54",
  webkit_version: "2.44.2",
  x11: true,
  debian_family: true,
};

let host: HTMLElement;
let component: ReturnType<typeof mount>;

function render(props: { onOpenSettings?: () => void } = {}) {
  component = mount(CompatNotice, { target: host, props });
  flushSync();
}

beforeEach(() => {
  compatState.report = null;
  compatState.dismissed = false;
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  if (component) unmount(component);
  host.remove();
});

describe("CompatNotice", () => {
  it("renders nothing when the notice is not visible", () => {
    compatState.report = { ...report, applied: false };
    render();
    expect(host.querySelector(".compat-notice")).toBeNull();
  });

  it("renders the reason line when auto decided to disable", () => {
    compatState.report = report;
    render();

    const bar = host.querySelector(".compat-notice")!;
    expect(bar.textContent).toContain(report.reason);
  });

  it("dismisses on the close button", () => {
    compatState.report = report;
    render();

    const dismiss = host.querySelector<HTMLButtonElement>(".compat-notice button.dismiss")!;
    expect(dismiss.getAttribute("aria-label")).toBe("Dismiss");
    dismiss.click();
    flushSync();

    expect(compatState.dismissed).toBe(true);
    expect(host.querySelector(".compat-notice")).toBeNull();
  });

  it("calls onOpenSettings from the settings button", () => {
    compatState.report = report;
    const onOpenSettings = vi.fn();
    render({ onOpenSettings });

    const settings = [...host.querySelectorAll<HTMLButtonElement>(".compat-notice button")].find(
      (b) => b.textContent!.trim() === "Settings",
    )!;
    settings.click();

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
