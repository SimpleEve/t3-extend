import { describe, expect, it } from "vite-plus/test";

import { parseFooterStatusToggles } from "./footerStatusStore";

describe("footer status toggles", () => {
  it("defaults every switch on and keeps whatever the user turned off", () => {
    const allOn = { limits: true, resources: true, ports: true, keepAwake: true };
    expect(parseFooterStatusToggles(null)).toEqual(allOn);
    expect(parseFooterStatusToggles("not json")).toEqual(allOn);
    expect(parseFooterStatusToggles(JSON.stringify({ ports: false, limits: "no" }))).toEqual({
      ...allOn,
      ports: false,
    });
  });
});
