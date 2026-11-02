import { loadUiCatalog, setUiLocale, translate } from "@t3tools/client-runtime/i18n";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ToastProvider, toastManager } from "./toast";

describe("toastManager", () => {
  it("shows a toast added before any provider mounted", async () => {
    toastManager.add({ type: "info", title: "Raised before the first render" });

    await using _screen = await render(<ToastProvider>{null}</ToastProvider>);

    await expect.element(page.getByText("Raised before the first render")).toBeVisible();
  });

  it("localizes text an updater function returns", async () => {
    const source = "Upload failed";
    await loadUiCatalog("zh-Hans");
    const localized = translate("zh-Hans", source);
    expect(localized).not.toBe(source);
    await setUiLocale("zh-Hans");
    try {
      await using _screen = await render(<ToastProvider>{null}</ToastProvider>);
      const id = toastManager.add({ type: "loading", title: "Working" });
      toastManager.update(id, () => ({ type: "error", title: source }));

      await expect.element(page.getByText(localized)).toBeVisible();
    } finally {
      await setUiLocale("en");
    }
  });
});
