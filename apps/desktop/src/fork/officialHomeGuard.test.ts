// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { assert, it } from "vite-plus/test";

import { officialHomeProblem } from "./officialHomeGuard.ts";

const home = "/Users/me";
const check = (
  baseDir: string,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly links?: Readonly<Record<string, string>>;
  } = {},
) =>
  officialHomeProblem({
    baseDir,
    homeDirectory: home,
    platform: options.platform ?? "linux",
    ...NodePath.posix,
    realPath: (path) => {
      const real = options.links?.[path];
      if (real === undefined) throw new Error("ENOENT");
      return real;
    },
  });

it("refuses official T3 Code's home by name, by link, and by spelling", () => {
  for (const [baseDir, options] of [
    ["/Users/me/.t3", {}],
    ["/Users/me/x/../.t3/", {}],
    ["/Users/me/.t3extend", { links: { "/Users/me/.t3extend": "/Users/me/.t3" } }],
    ["/Users/me/.T3", { platform: "darwin" as const }],
  ] as const) {
    assert.include(check(baseDir, options) ?? "", "T3 Code's data directory", baseDir);
  }
});

it("lets the fork's own home, other directories, and a worktree below the official home through", () => {
  for (const baseDir of [
    "/Users/me/.t3extend",
    "/Users/me/other",
    "/Users/me/.t3/worktrees/w/.t3",
    "/Users/me/.T3",
  ]) {
    assert.equal(check(baseDir), null, baseDir);
  }
});
