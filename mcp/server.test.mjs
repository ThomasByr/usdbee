import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BridgeHost, TOOLS, createMcpServer, spawnApp } from "./server.mjs";

// The contract, written out by hand (not read from TOOLS) so drift fails here.
// "name?" = optional; "vec3" = array of 3 numbers.
const CONTRACT = {
  status: {},
  load_scene: { path: "string" },
  unload_scene: {},
  inspect_scene: { "max_depth?": "integer" },
  search_objects: { query: "string", "limit?": "integer" },
  select_node: { path: "string" },
  transform_object: {
    path: "string",
    "position?": "vec3",
    "rotation?": "vec3",
    "scale?": "vec3",
  },
  play: {},
  pause: {},
  set_time: { time: "number" },
  get_performance: {},
  box_report: {},
  reset_performance: {},
  screenshot: {},
  set_camera: { "position?": "vec3", "target?": "vec3", "fov?": "number" },
  look_through_camera: { "path?": "string" },
  close_app: {},
  open_app: {},
};

/** @param {any} schema json schema from tools/list */
function project(schema) {
  const props = /** @type {Record<string, any>} */ (schema.properties ?? {});
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(props)) {
    out[key] = value.type === "array" ? `array<${/** @type {any} */ (value.items)?.type}>` : value.type;
  }
  return { props: out, required: [...(schema.required ?? [])].sort() };
}

function expectedShape(args) {
  /** @type {Record<string, string>} */
  const props = {};
  /** @type {string[]} */
  const required = [];
  for (const [key, type] of Object.entries(args)) {
    const optional = key.endsWith("?");
    const name = optional ? key.slice(0, -1) : key;
    props[name] = type === "vec3" ? "array<number>" : type;
    if (!optional) required.push(name);
  }
  return { props, required: required.sort() };
}

/** Fake usdbee bridge: a WS client that answers frames itself. */
async function fakeBridge(url, reply) {
  const ws = new WebSocket(url);
  await once(ws, "open");
  /** @type {any[]} */
  const received = [];
  ws.on("message", async (raw) => {
    const frame = JSON.parse(raw.toString());
    received.push(frame);
    const answer = await reply(frame);
    if (answer !== undefined) ws.send(JSON.stringify(answer));
  });
  return { ws, received };
}

/** The connection event may already have fired; waitConnected covers both. */
async function waitConnected(host) {
  if (host.connected) return;
  await once(host, "client", { signal: AbortSignal.timeout(5000) });
}

async function makeHost() {
  const host = new BridgeHost();
  const port = await host.listen(0);
  return { host, port, url: `ws://127.0.0.1:${port}` };
}

async function connectMcp(host) {
  const server = createMcpServer(host);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

/** @type {WebSocket[]} */
const sockets = [];
/** @type {BridgeHost[]} */
const hosts = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const host of hosts.splice(0)) host.close();
});

describe("tool table", () => {
  it("exposes exactly the contract commands plus open_app", async () => {
    const { host } = await makeHost();
    hosts.push(host);
    const client = await connectMcp(host);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(CONTRACT).sort());
  });

  it("declares the contract args on every tool", async () => {
    const { host } = await makeHost();
    hosts.push(host);
    const client = await connectMcp(host);
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const expected = expectedShape(CONTRACT[/** @type {keyof typeof CONTRACT} */ (tool.name)]);
      expect({ name: tool.name, ...project(tool.inputSchema) }).toEqual({
        name: tool.name,
        ...expected,
      });
    }
    expect(TOOLS).toHaveLength(Object.keys(CONTRACT).length);
  });
});

describe("round-trip", () => {
  it("forwards status and resolves on the matching id", async () => {
    const { host, url } = await makeHost();
    hosts.push(host);
    const bridge = await fakeBridge(url, (frame) => {
      if (frame.cmd === "status") {
        return {
          id: frame.id,
          ok: true,
          result: { stage_loaded: false, playing: false, time: 0 },
        };
      }
    });
    sockets.push(bridge.ws);
    await waitConnected(host);

    const client = await connectMcp(host);
    const answer = await client.callTool({ name: "status", arguments: {} });
    expect(answer.isError).toBeFalsy();
    expect(JSON.parse(/** @type {any} */ (answer.content[0]).text)).toEqual({
      stage_loaded: false,
      playing: false,
      time: 0,
    });
    expect(bridge.received).toHaveLength(1);
    expect(bridge.received[0].cmd).toBe("status");
    expect(typeof bridge.received[0].id).toBe("number");
  });

  it("passes the tool args through untouched", async () => {
    const { host, url } = await makeHost();
    hosts.push(host);
    const bridge = await fakeBridge(url, (frame) => ({
      id: frame.id,
      ok: true,
      result: { matches: [] },
    }));
    sockets.push(bridge.ws);
    await waitConnected(host);

    const client = await connectMcp(host);
    await client.callTool({
      name: "search_objects",
      arguments: { query: "wheel", limit: 3 },
    });
    expect(bridge.received[0].args).toEqual({ query: "wheel", limit: 3 });
  });

  it("ignores a reply that carries an unknown id", async () => {
    const { host, url } = await makeHost();
    hosts.push(host);
    const bridge = await fakeBridge(url, (frame) => ({
      id: frame.id + 99,
      ok: false,
      error: "stale",
    }));
    sockets.push(bridge.ws);
    await waitConnected(host);

    await expect(host.call("status", {}, 100)).rejects.toThrow(/timed out/);
  });

  it("keeps the newest connection when a second one arrives", async () => {
    const { host, url } = await makeHost();
    hosts.push(host);
    const first = await fakeBridge(url, () => undefined);
    sockets.push(first.ws);
    await waitConnected(host);

    const second = await fakeBridge(url, (frame) => ({
      id: frame.id,
      ok: true,
      result: { ok: true },
    }));
    sockets.push(second.ws);
    await once(first.ws, "close");

    await expect(host.call("play", {})).resolves.toEqual({ ok: true });
    expect(first.received).toHaveLength(0);
  });

  it("rejects calls in flight on a replaced connection", async () => {
    const { host, url } = await makeHost();
    hosts.push(host);
    const first = await fakeBridge(url, () => undefined);
    sockets.push(first.ws);
    await waitConnected(host);

    const inFlight = expect(host.call("play", {})).rejects.toThrow(/reconnected/);
    const second = await fakeBridge(url, (frame) => ({
      id: frame.id,
      ok: true,
      result: { ok: true },
    }));
    sockets.push(second.ws);
    await inFlight;
  });
});

describe("errors", () => {
  it("turns a bridge error envelope into a tool error", async () => {
    const { host, url } = await makeHost();
    hosts.push(host);
    const bridge = await fakeBridge(url, (frame) => ({
      id: frame.id,
      ok: false,
      error: "load_scene failed: no such file /nope.usda",
    }));
    sockets.push(bridge.ws);
    await waitConnected(host);

    const client = await connectMcp(host);
    const answer = await client.callTool({
      name: "load_scene",
      arguments: { path: "/nope.usda" },
    });
    expect(answer.isError).toBe(true);
    expect(JSON.stringify(answer.content)).toMatch(/no such file/);
  });

  it("fails fast and names open_app when no app is connected", async () => {
    const { host } = await makeHost();
    hosts.push(host);
    const client = await connectMcp(host);
    const answer = await client.callTool({ name: "status", arguments: {} });
    expect(answer.isError).toBe(true);
    const text = JSON.stringify(answer.content);
    expect(text).toMatch(/not connected/);
    expect(text).toMatch(/open_app/);
  });

  it("times out naming the app", async () => {
    const { host, url } = await makeHost();
    hosts.push(host);
    const bridge = await fakeBridge(url, () => undefined);
    sockets.push(bridge.ws);
    await waitConnected(host);
    await expect(host.call("status", {}, 60)).rejects.toThrow(/timed out.*usdbee app/s);
  });

  it("rejects an unknown tool name", async () => {
    const { host } = await makeHost();
    hosts.push(host);
    const client = await connectMcp(host);
    const answer = await client.callTool({
      name: "delete_everything",
      arguments: {},
    });
    expect(answer.isError).toBe(true);
    expect(JSON.stringify(answer.content)).toMatch(/delete_everything/);
  });
});

describe("screenshot", () => {
  it("returns an image content block", async () => {
    const { host, url } = await makeHost();
    hosts.push(host);
    const bridge = await fakeBridge(url, (frame) => ({
      id: frame.id,
      ok: true,
      result: { png_base64: "iVBORw0KGgo=" },
    }));
    sockets.push(bridge.ws);
    await waitConnected(host);

    const client = await connectMcp(host);
    const answer = await client.callTool({
      name: "screenshot",
      arguments: {},
    });
    const block = /** @type {any} */ (answer.content[0]);
    expect(block.type).toBe("image");
    expect(block.mimeType).toBe("image/png");
    expect(block.data).toBe("iVBORw0KGgo=");
  });
});

describe("stdio lifecycle", () => {
  it("exits and frees the port when stdin closes", async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], {
      env: { ...process.env, MCP_PORT: "0" },
      stdio: ["pipe", "ignore", "pipe"],
    });
    try {
      const announced = once(child.stderr, "data");
      child.stdin.end();
      const [exitCode] = await Promise.race([
        once(child, "exit"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("server did not exit")), 2000)),
      ]);
      expect(exitCode).toBe(0);
      const [stderr] = await announced;
      // The bound port is printed, not the requested 0.
      const match = String(stderr).match(/ws:\/\/127\.0\.0\.1:(\d+)/);
      expect(match).not.toBeNull();
      expect(Number(match[1])).toBeGreaterThan(0);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("open_app", () => {
  it("passes the bridge port to the spawned app's env", () => {
    /** @type {any[][]} */
    const calls = [];
    spawnApp(9400, (...args) => {
      calls.push(args);
      return { exitCode: null, pid: 7, unref() {} };
    });
    const [, , options] = calls[0];
    expect(options.env.VITE_MCP_PORT).toBe("9400");
    expect(options.env.PATH).toBe(process.env.PATH);
  });

  it("reports already-running when a bridge is connected", async () => {
    const { host, url } = await makeHost();
    hosts.push(host);
    const bridge = await fakeBridge(url, () => undefined);
    sockets.push(bridge.ws);
    await waitConnected(host);

    /** @type {any[]} */
    const spawns = [];
    host.spawn = (...args) => spawns.push(args);
    const result = await host.openApp({ waitMs: 50 });
    expect(result.status).toBe("already-running");
    expect(spawns).toHaveLength(0);
  });

  it("spawns once and reports the timeout, then refuses to spawn again", async () => {
    const { host, port } = await makeHost();
    hosts.push(host);
    /** @type {any[]} */
    const spawns = [];
    host.spawn = (...args) => {
      spawns.push(args);
      return { exitCode: null, pid: 4242 };
    };
    const first = await host.openApp({ waitMs: 120, pollMs: 20 });
    expect(spawns).toHaveLength(1);
    // The app is told which port to dial back, even a non-default one.
    expect(spawns[0]).toEqual([port]);
    expect(first.status).toBe("timeout");
    expect(first.log).toMatch(/usdbee-mcp-dev\.log/);

    const second = await host.openApp({ waitMs: 120, pollMs: 20 });
    expect(spawns).toHaveLength(1);
    expect(second.status).toBe("already-starting");
  });
});
