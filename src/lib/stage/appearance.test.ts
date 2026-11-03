import { describe, expect, it, vi } from "vitest";
import { applyToBranch } from "./appearance";

describe("applyToBranch", () => {
  it("commits once per path, sequentially, awaiting each", async () => {
    const order: string[] = [];
    const commit = vi.fn(async (path: string) => {
      // Resolve later paths first would reorder a parallel loop; the
      // sequential await keeps the actor-serialized order stable.
      await new Promise((r) => setTimeout(r, path === "/A" ? 10 : 0));
      order.push(path);
      return null;
    });

    const result = await applyToBranch(commit, ["/A", "/B"]);

    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenNthCalledWith(1, "/A");
    expect(commit).toHaveBeenNthCalledWith(2, "/B");
    expect(order).toEqual(["/A", "/B"]);
    expect(result).toEqual({ applied: 2, failed: 0, errors: [] });
  });

  it("continues past a failing prim and summarizes failures", async () => {
    const commit = vi.fn(async (path: string) => (path === "/B" ? "backend refused /B" : null));

    const result = await applyToBranch(commit, ["/A", "/B", "/C"]);

    expect(commit).toHaveBeenCalledTimes(3);
    expect(result.applied).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors).toEqual(["/B: backend refused /B"]);
  });

  it("handles an empty path list", async () => {
    const commit = vi.fn();
    const result = await applyToBranch(commit, []);
    expect(commit).not.toHaveBeenCalled();
    expect(result).toEqual({ applied: 0, failed: 0, errors: [] });
  });
});
