// Dev-only MCP bridge: hosts the loopback WS port the app's dev bridge dials
// into, and exposes those commands as MCP tools over stdio. Loopback only, no
// auth (local dev tool; the app side is import.meta.env.DEV gated).
import { spawn as spawnChild } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { closeSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { COMMANDS } from "../src/lib/commands/registry.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PORT = 9330;
const CALL_TIMEOUT_MS = 30_000;
const APP_WAIT_MS = 120_000;
const APP_POLL_MS = 250;
const LOG_PATH = "/tmp/usdbee-mcp-dev.log";

const vec3 = z.array(z.number()).length(3);

/**
 * @param {import("../src/lib/commands/registry.mjs").Arg} arg
 */
function argSchema(arg) {
  const base =
    arg.type === "vec3" ? vec3 : arg.type === "string" ? z.string() : arg.int ? z.number().int() : z.number();
  const described = arg.describe ? base.describe(arg.describe) : base;
  return arg.optional ? described.optional() : described;
}

/**
 * @param {import("../src/lib/commands/registry.mjs").Arg[]} args
 */
function inputSchema(args) {
  return Object.fromEntries(args.map((arg) => [arg.key, argSchema(arg)]));
}

/** Mirrors the WS command contract; the bridge validates nothing, so these are the enforcement. */
export const TOOLS = [
  ...COMMANDS.filter((command) => command.mcp !== false).map((command) => ({
    name: command.name,
    description: command.description,
    args: inputSchema(command.args),
  })),
  // Only this server can start the app, so the palette has nothing to run.
  {
    name: "open_app",
    description: "Start the app in dev mode when nothing is running, and wait for its bridge to connect.",
    args: {},
  },
];

export function spawnApp(port = DEFAULT_PORT, spawn = spawnChild) {
  const log = openSync(LOG_PATH, "a");
  const child = spawn("npm", ["run", "tauri", "dev"], {
    cwd: REPO_ROOT,
    detached: true,
    // The app's dev bridge dials this same port back (VITE_MCP_PORT is the
    // name it reads), so a non-default MCP_PORT has to reach the child.
    env: { ...process.env, VITE_MCP_PORT: String(port) },
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  child.unref();
  return child;
}

export class BridgeHost extends EventEmitter {
  #wss = null;
  #client = null;
  #pending = new Map();
  #nextId = 1;
  #child = null;
  #port = DEFAULT_PORT;

  spawn = spawnApp;

  listen(port = DEFAULT_PORT) {
    this.#wss = new WebSocketServer({ host: "127.0.0.1", port });
    this.#wss.on("connection", (socket) => {
      // One app at a time: a new connection replaces the old one, and calls
      // in flight on the replaced socket cannot be answered by anyone now.
      if (this.#client && this.#client !== socket) {
        this.#failPending("bridge reconnected — the request was in flight on the replaced connection");
        this.#client.close();
      }
      this.#client = socket;
      socket.on("message", (raw) => this.#onFrame(raw));
      socket.on("close", () => {
        if (this.#client === socket) this.#client = null;
      });
      socket.on("error", () => {});
      this.emit("client");
    });
    return new Promise((resolvePort, reject) => {
      this.#wss.once("listening", () => {
        this.#port = this.#wss.address().port;
        resolvePort(this.#port);
      });
      this.#wss.once("error", reject);
    });
  }

  get connected() {
    return this.#client?.readyState === 1;
  }

  get spawning() {
    return this.#child !== null && this.#child.exitCode === null;
  }

  call(cmd, args = {}, timeoutMs = CALL_TIMEOUT_MS) {
    if (!this.connected) {
      return Promise.reject(new Error(`usdbee app not connected to the bridge — call open_app to start it`));
    }
    const id = this.#nextId++;
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectCall(
          new Error(
            `${cmd} timed out after ${timeoutMs}ms — the usdbee app is probably not running or is stuck`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
      this.#client.send(JSON.stringify({ id, cmd, args }));
    });
  }

  async openApp({ waitMs = APP_WAIT_MS, pollMs = APP_POLL_MS } = {}) {
    if (this.connected) return { status: "already-running", log: LOG_PATH };
    if (this.spawning) {
      return { status: "already-starting", log: LOG_PATH, pid: this.#child.pid };
    }
    const child = this.spawn(this.#port);
    this.#child = child;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (this.connected) {
        return { status: "connected", log: LOG_PATH, pid: child.pid };
      }
      if (child.exitCode !== null && child.exitCode !== undefined) {
        return { status: "app-exited", log: LOG_PATH, exit_code: child.exitCode };
      }
      await sleep(pollMs);
    }
    return { status: "timeout", log: LOG_PATH, pid: child.pid };
  }

  close() {
    this.#failPending("bridge server shutting down");
    // The app is left running: only the host this server owns goes away.
    this.#client?.close();
    this.#client = null;
    this.#wss?.close();
    this.#wss = null;
  }

  #failPending(message) {
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
    }
    this.#pending.clear();
  }

  #onFrame(raw) {
    let frame;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const entry = this.#pending.get(frame?.id);
    if (!entry) return;
    this.#pending.delete(frame.id);
    clearTimeout(entry.timer);
    if (frame.ok) entry.resolve(frame.result);
    else entry.reject(new Error(String(frame.error ?? "bridge error")));
  }
}

export function createMcpServer(host) {
  const server = new McpServer({ name: "usdbee", version: "0.1.0" });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.args },
      async (args) => {
        const result =
          tool.name === "open_app" ? await host.openApp() : await host.call(tool.name, args ?? {});
        if (tool.name === "screenshot") {
          return {
            content: [
              {
                type: "image",
                data: String(result?.png_base64 ?? ""),
                mimeType: "image/png",
              },
            ],
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result ?? {}) }],
        };
      },
    );
  }
  return server;
}

async function main() {
  const port = Number(process.env.MCP_PORT ?? DEFAULT_PORT);
  const host = new BridgeHost();
  const boundPort = await host.listen(port);
  const server = createMcpServer(host);
  const transport = new StdioServerTransport();
  transport.onclose = () => host.close();
  // The transport never sees stdin EOF, so shut down here: closing the host is
  // all we owe, the app itself keeps running.
  const shutdown = () => {
    host.close();
    process.exit(0);
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  await server.connect(transport);
  process.stderr.write(`usdbee dev bridge on ws://127.0.0.1:${boundPort}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
