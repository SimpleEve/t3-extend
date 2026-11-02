import { setUiLocale } from "@t3tools/client-runtime/i18n";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { useMarkdownTypography } from "./useMarkdownTypography";

vi.mock("../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ appearance: { baseFontSize: 16 } }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  await act(() => setUiLocale("en"));
});

it("re-resolves Markdown sizes through the real hook when the language switches", async () => {
  const seen: Array<ReturnType<typeof useMarkdownTypography>> = [];
  function Probe() {
    seen.push(useMarkdownTypography());
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  expect(seen.at(-1)).toMatchObject({ fontSize: 16, headingFontSizes: [21, 19, 17, 15, 15, 15] });

  await act(() => setUiLocale("zh-Hans"));
  expect(seen.at(-1)).toMatchObject({ fontSize: 15, headingFontSizes: [20, 18, 16, 14, 14, 14] });

  await act(async () => root.unmount());
});
