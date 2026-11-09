import { loadUiCatalog, setUiLocale } from "@t3tools/client-runtime/i18n";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { verbatim } from "~/fork/verbatim";
import { render } from "../../../test/render";
import { SettingsSection } from "./settingsLayout";

it("translates a section title that is copy, and shows one that is the user's own text as it is", async () => {
  await loadUiCatalog("zh-Hans");
  await setUiLocale("zh-Hans");
  try {
    // `server` is a catalog key (服务器): dev servers name the project for apps/server that.
    await using _screen = await render(
      <>
        <SettingsSection title="Appearance">{null}</SettingsSection>
        <SettingsSection title={verbatim("server")}>{null}</SettingsSection>
      </>,
    );
    await expect.element(page.getByRole("heading", { name: "外观" })).toBeVisible();
    await expect.element(page.getByRole("heading", { name: "server" })).toBeVisible();
    await expect.element(page.getByRole("heading", { name: "服务器" })).not.toBeInTheDocument();
  } finally {
    await setUiLocale("en");
  }
});
