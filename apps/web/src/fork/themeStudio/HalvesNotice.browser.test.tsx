import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { THEME_HALVES_STORAGE_KEY } from "../../themePalette";
import { HalvesNotice } from "./HalvesNotice";
import { useThemeStudio } from "./useThemeStudio";

function Harness() {
  const studio = useThemeStudio();
  return (
    <div>
      <HalvesNotice studio={studio} />
      <button type="button" onClick={() => studio.select("studio-tide")}>
        pick a whole theme
      </button>
    </div>
  );
}

it("takes the light and dark notice away once a whole theme replaces the pair", async () => {
  window.localStorage.setItem(
    THEME_HALVES_STORAGE_KEY,
    JSON.stringify({ light: "studio-paper", dark: "studio-terminal" }),
  );
  await using _screen = await render(<Harness />);
  await expect.element(page.getByText(/Light and dark use different themes/)).toBeVisible();
  await page.getByRole("button", { name: "pick a whole theme" }).click();
  await expect
    .element(page.getByText(/Light and dark use different themes/))
    .not.toBeInTheDocument();
  expect(window.localStorage.getItem(THEME_HALVES_STORAGE_KEY)).toBeNull();
});
