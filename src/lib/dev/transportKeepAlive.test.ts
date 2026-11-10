import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { KEEP_ALIVE_MS, pingTransport, startTransportKeepAlive } from "./transportKeepAlive";

const mockedInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.useFakeTimers();
  mockedInvoke.mockReset();
  mockedInvoke.mockResolvedValue("ws://127.0.0.1:1");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("transport keep-alive", () => {
  it("pings once per cadence while idle", async () => {
    const ping = vi.fn().mockResolvedValue(1);
    const stop = startTransportKeepAlive({ isIdle: () => true, ping });

    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS - 1);
    expect(ping).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ping).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS * 3);
    expect(ping).toHaveBeenCalledTimes(4);

    stop();
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS * 5);
    expect(ping).toHaveBeenCalledTimes(4);
  });

  it("holds the ping while the transport is busy", async () => {
    let idle = false;
    const ping = vi.fn().mockResolvedValue(1);
    const stop = startTransportKeepAlive({ isIdle: () => idle, ping });

    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS * 4);
    expect(ping).not.toHaveBeenCalled();

    idle = true;
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS);
    expect(ping).toHaveBeenCalledTimes(1);
    stop();
  });

  it("never stacks a ping behind one already on the wire", async () => {
    let settled: (value: unknown) => void = () => {};
    const ping = vi.fn(() => new Promise((resolve) => (settled = resolve)));
    const stop = startTransportKeepAlive({ isIdle: () => true, ping });

    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS);
    expect(ping).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS * 3);
    expect(ping).toHaveBeenCalledTimes(1);

    settled(1);
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS);
    expect(ping).toHaveBeenCalledTimes(2);
    stop();
  });

  it("starts nothing outside a dev build", async () => {
    vi.stubEnv("DEV", false);
    const ping = vi.fn().mockResolvedValue(1);
    const stop = startTransportKeepAlive({ isIdle: () => true, ping });

    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS * 4);
    expect(ping).not.toHaveBeenCalled();
    stop();
  });

  it("pings the cheapest command and measures its own wall time", async () => {
    await pingTransport();

    expect(mockedInvoke).toHaveBeenCalledWith("get_omniverse_url");
  });
});
