import { describe, expect, it } from "vite-plus/test";

import { loadModuleGraph, stats } from "./firstPaint.ts";

describe("stats", () => {
  it("takes nearest-rank percentiles of an unsorted list", () => {
    const result = stats([9, 1, 5, 3, 7, 2, 8, 4, 6, 10]);
    expect(result).toEqual({ n: 10, median: 5, p95: 10 });
    expect(stats(Array.from({ length: 20 }, (_, i) => i + 1)).p95).toBe(19);
  });
});

describe("loadModuleGraph", () => {
  it("walks the graph breadth first, never past six requests at once, each module once", async () => {
    // 0 -> 1..10 -> each of those also names module 11, which must still be fetched only once.
    const graph = new Map<string, ReadonlyArray<string>>([
      ["/m/0.js", Array.from({ length: 10 }, (_, i) => `/m/${i + 1}.js`)],
      ...Array.from({ length: 10 }, (_, i): [string, ReadonlyArray<string>] => [
        `/m/${i + 1}.js`,
        ["/m/11.js"],
      ]),
      ["/m/11.js", []],
    ]);
    const requested: Array<string> = [];
    let inFlight = 0;
    let peak = 0;
    const load = await loadModuleGraph(async (path) => {
      requested.push(path);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return {
        status: 200,
        body: (graph.get(path) ?? []).map((child) => `import "${child}";`).join("\n"),
      };
    });
    expect(load.requests).toBe(12);
    expect(new Set(requested).size).toBe(12);
    expect(requested[0]).toBe("/m/0.js");
    expect(peak).toBeLessThanOrEqual(6);
  });

  it("fails on a module that does not answer 200", async () => {
    await expect(loadModuleGraph(async () => ({ status: 503, body: "" }))).rejects.toThrow(/503/u);
  });
});
