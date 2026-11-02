import { describe, expect, it } from "@effect/vitest";

import { loadUiCatalog, translatorFor } from "@t3tools/client-runtime/i18n";

import { projectThreadContentPresentation } from "./threadContentPresentation";

const t = translatorFor("en");

describe("thread content presentation", () => {
  it("renders cached detail while its environment reconnects", () => {
    expect(
      projectThreadContentPresentation({
        hasDetail: true,
        detailError: null,
        detailDeleted: false,
        connectionState: "reconnecting",
        t,
      }),
    ).toEqual({ kind: "ready" });
  });

  it("explains uncached detail while disconnected instead of loading forever", () => {
    expect(
      projectThreadContentPresentation({
        hasDetail: false,
        detailError: null,
        detailDeleted: false,
        connectionState: "error",
        t,
      }),
    ).toEqual({
      kind: "unavailable",
      title: "Messages not cached",
      detail: "Reconnect this environment to load the conversation.",
    });
  });

  it("follows the translator it is given", async () => {
    await loadUiCatalog("zh-Hans");
    expect(
      projectThreadContentPresentation({
        hasDetail: false,
        detailError: null,
        detailDeleted: true,
        connectionState: "connected",
        t: translatorFor("zh-Hans"),
      }),
    ).toMatchObject({ kind: "unavailable", title: "对话不可用" });
  });
});
