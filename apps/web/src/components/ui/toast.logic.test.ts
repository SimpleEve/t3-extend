import { loadUiCatalog, translate } from "@t3tools/client-runtime/i18n";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { localizeToastText } from "./toast.logic";

const KNOWN = "Upload failed";
const UNKNOWN = "Server said: disk quota exceeded";

describe("localizeToastText", () => {
  beforeAll(async () => {
    await loadUiCatalog("zh-Hans");
  });

  it("looks up fixed client text and leaves other text and fields as they were", () => {
    const localized = translate("zh-Hans", KNOWN);
    expect(localized).not.toBe(KNOWN);

    const options = { title: KNOWN, description: UNKNOWN, type: "error" as const };
    expect(localizeToastText(options, "zh-Hans")).toEqual({
      title: localized,
      description: UNKNOWN,
      type: "error",
    });
    // Already translated text is not in the catalog, so a second pass changes nothing.
    expect(localizeToastText({ title: localized }, "zh-Hans")).toEqual({ title: localized });
    expect(localizeToastText(options, "en")).toEqual(options);
    expect("description" in localizeToastText({ title: KNOWN }, "zh-Hans")).toBe(false);

    const onClick = () => undefined;
    expect(
      localizeToastText({ actionProps: { children: KNOWN, onClick } }, "zh-Hans").actionProps,
    ).toEqual({ children: localized, onClick });
  });
});
