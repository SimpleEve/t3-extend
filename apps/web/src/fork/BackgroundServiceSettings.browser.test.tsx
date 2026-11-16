import type {
  BackgroundServiceBridge,
  BackgroundServiceState,
} from "@t3tools/shared/backgroundService";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render, stubGlobal } from "../../test/render";

vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: (() => "primary") as never,
}));

import { BackgroundServiceSettings } from "./BackgroundServiceSettings";

function stubBridge(initial: BackgroundServiceState) {
  let state = initial;
  const setEnabled = vi.fn(async (enabled: boolean) => {
    state = enabled ? { kind: "on" } : { kind: "off" };
    return { state, error: null };
  });
  const bridge: BackgroundServiceBridge = { getState: async () => state, setEnabled };
  return { setEnabled, global: stubGlobal("t3xBackgroundServiceBridge", bridge) };
}

describe("background service switch", () => {
  it("shows an installed service as on and removes it when switched off", async () => {
    const { setEnabled, global } = stubBridge({ kind: "on" });
    using _global = global;
    await using _screen = await render(<BackgroundServiceSettings />, { router: false });

    await expect
      .element(page.getByText("On. T3 Extend keeps running after you quit the app."))
      .toBeVisible();
    await userEvent.click(page.getByRole("switch", { name: "Keep running in the background" }));

    await vi.waitFor(() => expect(setEnabled).toHaveBeenCalledWith(false));
    await expect
      .element(page.getByText("Off. Quitting the app also stops T3 Extend."))
      .toBeVisible();
  });

  it("says the service did not start at the last quit, and installs it again on retry", async () => {
    const { setEnabled, global } = stubBridge({
      kind: "attention",
      problem: "resume-failed",
      reason: "Bootstrap failed: 5: Input/output error",
    });
    using _global = global;
    await using _screen = await render(<BackgroundServiceSettings />, { router: false });

    await expect
      .element(
        page.getByText(
          "The background service did not start when you last quit: Bootstrap failed: 5: Input/output error",
        ),
      )
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Retry" }));

    await vi.waitFor(() => expect(setEnabled).toHaveBeenCalledWith(true));
    await expect
      .element(page.getByText("On. T3 Extend keeps running after you quit the app."))
      .toBeVisible();
  });

  it("renders nothing where there is no bridge", async () => {
    await using screen = await render(<BackgroundServiceSettings />, { router: false });
    expect(screen.container.textContent).toBe("");
  });
});
