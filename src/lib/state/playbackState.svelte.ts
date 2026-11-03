// Playback preferences (Task 13): the persisted `usdbee_playback` store.
// Currently just the timeline's unit display; follow the controlsState
// merge-spread load pattern so future fields migrate cleanly.

export type TimelineUnits = "frames-seconds" | "frames" | "seconds";

const STORAGE_KEY = "usdbee_playback";
const VALID_UNITS: TimelineUnits[] = ["frames-seconds", "frames", "seconds"];

export const playbackState = $state({
  timelineUnits: "frames-seconds" as TimelineUnits,
});

export function setTimelineUnits(units: TimelineUnits): void {
  playbackState.timelineUnits = units;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ timelineUnits: units }));
  } catch (e) {
    console.warn("Failed to persist playback preferences", e);
  }
}

// Migration-safe load: a missing, corrupt or invalid stored value keeps the
// default; only known fields are merged (controlsState pattern).
export function loadPlaybackState(): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch (e) {
    console.warn("Failed to read playback preferences", e);
  }
  if (!saved) return;
  try {
    const parsed = JSON.parse(saved);
    if (typeof parsed === "object" && parsed !== null && VALID_UNITS.includes(parsed.timelineUnits)) {
      playbackState.timelineUnits = parsed.timelineUnits;
    }
  } catch (e) {
    console.warn("Failed to load playback preferences", e);
  }
}

// Formats one playhead/duration value (a 0-based frame offset) per the
// timeline's unit setting. tcps 0 (unreadable rate) falls back to frames —
// dividing would invent a seconds readout.
export function formatTimeline(frame: number, tcps: number, units: TimelineUnits): string {
  const frames = String(Math.round(frame));
  if (units === "frames" || tcps <= 0) return frames;
  const seconds = `${(frame / tcps).toFixed(1)} s`;
  return units === "seconds" ? seconds : `${frames} · ${seconds}`;
}

// The slider duration is an offset; its right-hand label is the absolute end.
export function formatTimelineEnd(
  duration: number,
  startTimeCode: number,
  tcps: number,
  units: TimelineUnits,
): string {
  return formatTimeline(duration + startTimeCode, tcps, units);
}
