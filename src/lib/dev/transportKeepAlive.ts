// Dev-only transport keep-alive: the dev window's WebKitGTK ipc transport is
// suspected of sleeping after ~2 s without invokes, which would put a 1-2.7 s
// wake-up on the first pose batch after pressing play. One cheap invoke per
// idle interval keeps the transport busy on a fixed schedule, so that
// suspicion cannot land on a frame the user asked for.
//
// Measured on the bike stage in a dev window: the ping itself never paid a
// stall (29-31 ms after idles of 0.5-20 s), and no ping cadence (0.5-3 s)
// changed the first batch after a resume — the sleep did not reproduce there.
// It stays as idle-time insurance, out of every release build.
// shortcut: WebKitGTK dev-origin transport only; revisit if a release build ever shows a first-invoke stall.
import { invoke } from "@tauri-apps/api/core";

// Largest interval tested that still keeps one ping inside the suspected ~2 s
// sleep window, with room for the reply.
export const KEEP_ALIVE_MS = 1000;

/** The cheapest invoke in the app: no args, a state read, no USD work. */
export async function pingTransport(): Promise<number> {
  const startedAt = performance.now();
  await invoke<string>("get_omniverse_url");
  return performance.now() - startedAt;
}

export interface KeepAliveOptions {
  // True while the transport carries nothing: paused, and no load in flight.
  // Playback is excluded by the caller — it invokes on its own schedule.
  isIdle: () => boolean;
  cadenceMs?: number;
  /** Test seam: the real ping otherwise. */
  ping?: () => Promise<unknown>;
}

/**
 * Pings once per cadence while idle. Returns a stop function; outside a dev
 * build it returns without starting anything, which (with the dynamic import
 * at the call site) keeps this module out of the release bundle.
 */
export function startTransportKeepAlive(options: KeepAliveOptions): () => void {
  if (!import.meta.env.DEV) return () => {};
  const cadenceMs = options.cadenceMs ?? KEEP_ALIVE_MS;
  const ping = options.ping ?? pingTransport;
  // A ping already on the wire is the keep-alive: a second one would only
  // queue behind it on the serialized transport.
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight || !options.isIdle()) return;
    inFlight = true;
    void ping()
      .catch(() => {})
      .finally(() => (inFlight = false));
  }, cadenceMs);
  return () => clearInterval(timer);
}
