import { describe, expect, it } from "vite-plus/test";

import { parseGatewayStorage } from "./disabledStore";

describe("gateway storage", () => {
  const rows: ReadonlyArray<
    readonly [
      string,
      string | null,
      { disabled: ReadonlyArray<string>; wasActive: ReadonlyArray<string> },
    ]
  > = [
    ["nothing stored", null, { disabled: [], wasActive: [] }],
    [
      "both lists",
      JSON.stringify({ disabled: ["env-a", "env-b"], wasActive: ["env-c"] }),
      { disabled: ["env-a", "env-b"], wasActive: ["env-c"] },
    ],
    [
      "written before the second list existed",
      JSON.stringify({ disabled: ["env-a"] }),
      { disabled: ["env-a"], wasActive: [] },
    ],
    [
      "non-strings dropped",
      JSON.stringify({ disabled: ["env-a", 3, null], wasActive: [1, "env-b"] }),
      { disabled: ["env-a"], wasActive: ["env-b"] },
    ],
    [
      "wrong shape",
      JSON.stringify({ disabled: "env-a", wasActive: {} }),
      { disabled: [], wasActive: [] },
    ],
    ["not an object", JSON.stringify(["env-a"]), { disabled: [], wasActive: [] }],
    ["not json", "{", { disabled: [], wasActive: [] }],
  ];
  it.each(rows)("reads %s", (_name, raw, expected) => {
    expect(parseGatewayStorage(raw)).toEqual(expected);
  });
});
