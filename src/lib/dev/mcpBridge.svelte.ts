// Dev-only MCP bridge: the running app dials OUT to the local MCP server's
// WebSocket host and executes the commands a coding agent sends. The command
// set itself lives in $lib/commands/dispatch, which the palette shares; only
// the transport and its dev-only ping stay here. A production bundle must
// carry none of this: startMcpBridge returns null outside a dev build, and
// the caller imports it dynamically behind the same gate.

import { dispatchCommand, numberArg, type BridgeViewer } from "$lib/commands/dispatch";
import { pingTransport } from "$lib/dev/transportKeepAlive";

export { dispatchCommand, type BridgeViewer };

export const MCP_BRIDGE_PORT = 9330;
const RECONNECT_MAX_MS = 30000;

export function reconnectDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, RECONNECT_MAX_MS);
}

function bridgeUrl(): string {
  const port = Number(import.meta.env.VITE_MCP_PORT) || MCP_BRIDGE_PORT;
  return `ws://127.0.0.1:${port}`;
}

// Ids being answered: a duplicate frame for an id already in flight is
// dropped rather than run twice.
const inFlight = new Set<number>();

// One wire frame in, one envelope out (null for an unusable frame).
export async function handleMessage(viewer: BridgeViewer, raw: string): Promise<string | null> {
  let request: { id?: unknown; cmd?: unknown; args?: unknown };
  try {
    request = JSON.parse(raw);
  } catch {
    return null;
  }
  const id = numberArg(request?.id);
  if (id === null || inFlight.has(id)) return null;
  inFlight.add(id);
  try {
    const args =
      request.args && typeof request.args === "object" ? (request.args as Record<string, unknown>) : {};
    const cmd = String(request.cmd ?? "");
    // The keep-alive's own invoke, timed from the app side: what an idle
    // transport charges the next caller. It measures this dev transport, so
    // it is answered here rather than in the shared command set.
    const result = cmd === "ping" ? { ms: await pingTransport() } : await dispatchCommand(viewer, cmd, args);
    return JSON.stringify({ id, ok: true, result });
  } catch (e) {
    return JSON.stringify({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
  } finally {
    inFlight.delete(id);
  }
}

// Connect the app to the MCP server's host. Null (and no socket) outside a
// dev build, which is what keeps the release bundle free of this module.
export function startMcpBridge(viewer: BridgeViewer): (() => void) | null {
  if (!import.meta.env.DEV) return null;
  const url = bridgeUrl();
  let socket: WebSocket | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const connect = () => {
    const fresh = new WebSocket(url);
    socket = fresh;
    fresh.onopen = () => {
      attempt = 0;
      console.info("usdbee: dev MCP bridge connected on", url);
    };
    fresh.onmessage = (event) => {
      void handleMessage(viewer, String(event.data)).then((reply) => {
        if (reply !== null && socket?.readyState === WebSocket.OPEN) socket.send(reply);
      });
    };
    // A refused connection closes too, so one backoff path serves both.
    fresh.onclose = () => {
      if (stopped) return;
      timer = setTimeout(connect, reconnectDelay(attempt++));
    };
  };

  connect();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    socket?.close();
    socket = null;
  };
}
