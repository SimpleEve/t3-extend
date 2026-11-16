import { describe, expect, it } from "vite-plus/test";

import { hostCliCommand } from "./hostCli.logic";

describe("hostCliCommand", () => {
  it.each([
    ["this machine", { local: true }, "t3x"],
    [
      "a launcher, by its own name",
      { installation: launcher("/home/me/.t3extend/bin/t3x") },
      "t3x",
    ],
    ["an official launcher", { installation: launcher("/home/me/.local/bin/t3") }, "t3"],
    ["a Windows launcher", { installation: launcher("C:\\Users\\me\\bin\\t3.cmd") }, "t3"],
    ["npm", { installation: { kind: "npm-global", prefix: "/usr/local" } as const }, "t3"],
    ["npx", { installation: { kind: "npx" } as const }, "t3"],
    ["a host that reports nothing", {}, null],
  ])("answers for %s", (_case, input, expected) => {
    expect(hostCliCommand(input)).toBe(expected);
  });
});

function launcher(path: string) {
  return { kind: "t3-launcher", launcher: path, baseDir: "/home/me/.t3" } as const;
}
