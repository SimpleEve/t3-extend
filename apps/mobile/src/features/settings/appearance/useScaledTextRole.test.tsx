import { setUiLocale } from "@t3tools/client-runtime/i18n";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { useScaledTextRole, type ScaledTextRole } from "./useScaledTextRole";

vi.mock("./AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ appearance: { baseFontSize: 16 } }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("useScaledTextRole", () => {
  afterEach(async () => {
    await act(() => setUiLocale("en"));
  });

  it("re-renders with the Chinese size when the language switches", async () => {
    const seen: ScaledTextRole[] = [];
    function Probe() {
      seen.push(useScaledTextRole("body"));
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe />));
    expect(seen.at(-1)?.fontSize).toBe(16);

    await act(() => setUiLocale("zh-Hans"));
    expect(seen.at(-1)?.fontSize).toBe(15);

    await act(async () => root.unmount());
  });
});
