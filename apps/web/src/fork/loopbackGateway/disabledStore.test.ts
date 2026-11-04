import { describe, expect, it } from "vite-plus/test";

import { parseDisabledGateway } from "./disabledStore";

describe("disabled gateway storage", () => {
  const rows: ReadonlyArray<readonly [string, string | null, ReadonlyArray<string>]> = [
    ["nothing stored", null, []],
    ["the stored list", JSON.stringify({ disabled: ["env-a", "env-b"] }), ["env-a", "env-b"]],
    ["non-strings dropped", JSON.stringify({ disabled: ["env-a", 3, null] }), ["env-a"]],
    ["wrong shape", JSON.stringify({ disabled: "env-a" }), []],
    ["not an object", JSON.stringify(["env-a"]), []],
    ["not json", "{", []],
  ];
  it.each(rows)("%s", (_name, raw, expected) => {
    expect(parseDisabledGateway(raw).disabled).toEqual(expected);
  });
});
