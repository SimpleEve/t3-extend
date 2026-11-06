import type { AuthSessionState, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  sessionAtom: null as unknown,
  phase: "offline",
  canOperate: false,
}));

vi.mock(import("~/state/session"), () => ({
  useEnvironmentScope: () => mocks.canOperate,
  environmentSession: { sessionStateAtom: () => mocks.sessionAtom },
}));
vi.mock(import("~/state/environments"), () => ({
  useEnvironment: () => ({ label: "Studio", connection: { phase: mocks.phase } }),
}));
vi.mock(import("~/browser/previewRuntime"), () => ({ usePreviewAvailable: () => true }));
vi.mock(import("~/components/preview/PreviewView"), () => ({
  PreviewView: () => <div data-testid="preview-view" />,
}));

import { PreviewPanel } from "~/components/preview/PreviewPanel";

const threadRef = {
  environmentId: "env-studio" as EnvironmentId,
  threadId: "t",
} as ScopedThreadRef;

function setup(input: {
  readonly result: AsyncResult.AsyncResult<AuthSessionState, unknown>;
  readonly phase: string;
  readonly canOperate: boolean;
}) {
  mocks.sessionAtom = Atom.make(input.result);
  mocks.phase = input.phase;
  mocks.canOperate = input.canOperate;
}

const renderPanel = () =>
  render(<PreviewPanel mode="embedded" threadRef={threadRef} visible />, { router: false });

describe("the preview panel of an environment that cannot be reached", () => {
  it("says the environment is unreachable, not that the client must pair again", async () => {
    setup({ result: AsyncResult.initial(), phase: "offline", canOperate: false });
    await using screen = await renderPanel();
    await expect
      .element(
        screen.getByText("Can't reach Studio. Browser previews come back once it is connected."),
      )
      .toBeVisible();
    expect(screen.container.textContent).not.toContain("Pair this client again");
  });

  it("still asks to pair again when the session was read and grants no preview access", async () => {
    setup({
      result: AsyncResult.success({ authenticated: true, scopes: [] } as never),
      phase: "connected",
      canOperate: false,
    });
    await using screen = await renderPanel();
    await expect
      .element(
        screen.getByText("Pair this client again with preview access to control browser previews."),
      )
      .toBeVisible();
  });

  it("asks to pair again for a session read that was refused, as long as the environment is connected", async () => {
    setup({
      result: AsyncResult.fail(new Error("unauthorized")),
      phase: "connected",
      canOperate: false,
    });
    await using screen = await renderPanel();
    await expect
      .element(screen.getByText("Pair this client again", { exact: false }))
      .toBeVisible();
  });

  it("opens the preview when the grant is known, even while the environment is offline", async () => {
    setup({
      result: AsyncResult.success({ authenticated: true, scopes: ["preview:operate"] } as never),
      phase: "offline",
      canOperate: true,
    });
    await using screen = await renderPanel();
    expect(screen.container.querySelector("[data-testid=preview-view]")).not.toBeNull();
  });
});
