// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

// Runes modules hold module-level $state; reset modules so each test gets a
// fresh store instead of leaking units between tests.
async function freshPlaybackModule() {
  vi.resetModules();
  return await import("./playbackState.svelte");
}

beforeEach(() => {
  localStorage.clear();
});

describe("formatTimeline", () => {
  it("formats frames and seconds together in frames-seconds mode", async () => {
    const { formatTimeline } = await freshPlaybackModule();
    expect(formatTimeline(1234, 24, "frames-seconds")).toBe("1234 · 51.4 s");
  });

  it("formats frames only in frames mode", async () => {
    const { formatTimeline } = await freshPlaybackModule();
    expect(formatTimeline(1234, 24, "frames")).toBe("1234");
  });

  it("formats seconds only with one decimal in seconds mode", async () => {
    const { formatTimeline } = await freshPlaybackModule();
    expect(formatTimeline(1234, 24, "seconds")).toBe("51.4 s");
  });

  it("falls back to frames when time codes per second is 0", async () => {
    const { formatTimeline } = await freshPlaybackModule();
    expect(formatTimeline(123, 0, "frames-seconds")).toBe("123");
    expect(formatTimeline(123, 0, "seconds")).toBe("123");
    expect(formatTimeline(123, 0, "frames")).toBe("123");
  });

  it("formats the degenerate zero-length range without NaN or Infinity", async () => {
    const { formatTimeline } = await freshPlaybackModule();
    expect(formatTimeline(0, 24, "frames-seconds")).toBe("0 · 0.0 s");
    expect(formatTimeline(0, 24, "seconds")).toBe("0.0 s");
    // A degenerate backend range also reports tcps 0: still plain frames.
    expect(formatTimeline(0, 0, "frames-seconds")).toBe("0");
  });
});

describe("playbackState persistence", () => {
  it("defaults to frames-seconds when nothing is stored", async () => {
    const { playbackState } = await freshPlaybackModule();
    expect(playbackState.timelineUnits).toBe("frames-seconds");
  });

  it("loads a stored preference (migration-safe merge)", async () => {
    localStorage.setItem("usdbee_playback", JSON.stringify({ timelineUnits: "seconds" }));
    const { playbackState, loadPlaybackState } = await freshPlaybackModule();

    loadPlaybackState();

    expect(playbackState.timelineUnits).toBe("seconds");
  });

  it("keeps the default for a missing, corrupt or invalid stored value", async () => {
    localStorage.setItem("usdbee_playback", "{corrupt json");
    const first = await freshPlaybackModule();
    first.loadPlaybackState();
    expect(first.playbackState.timelineUnits).toBe("frames-seconds");

    localStorage.clear();
    localStorage.setItem("usdbee_playback", JSON.stringify({ timelineUnits: "parsecs" }));
    const second = await freshPlaybackModule();
    second.loadPlaybackState();
    expect(second.playbackState.timelineUnits).toBe("frames-seconds");

    localStorage.clear();
    localStorage.setItem("usdbee_playback", JSON.stringify({ timelineUnits: 7 }));
    const third = await freshPlaybackModule();
    third.loadPlaybackState();
    expect(third.playbackState.timelineUnits).toBe("frames-seconds");
  });

  it("persists unit changes immediately", async () => {
    const { playbackState, setTimelineUnits } = await freshPlaybackModule();

    setTimelineUnits("frames");

    expect(playbackState.timelineUnits).toBe("frames");
    expect(localStorage.getItem("usdbee_playback")).toBe(JSON.stringify({ timelineUnits: "frames" }));
  });
});
