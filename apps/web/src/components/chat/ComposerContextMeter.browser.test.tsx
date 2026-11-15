import "~/index.css";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  ring: null as { percent: number; tone: "warning" | "error" | null } | null,
  meter: null as unknown,
  speed: null as unknown,
}));

vi.mock(import("~/state/entities"), () => ({
  useThreadContextRing: () => state.ring,
  useThreadContextMeter: () => state.meter,
  useThreadLastTurnSpeed: () => state.speed,
}));

import { render } from "../../../test/render";
import { ComposerContextMeter } from "./ComposerContextMeter";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");

function setup(percent: number, tone: "warning" | "error" | null = null, withSpeed = true) {
  state.ring = { percent, tone };
  state.meter = {
    percent,
    usedTokens: 97_807,
    maxTokens: 272_000,
    tone,
    autoCompactPercent: 70,
  };
  state.speed = withSpeed
    ? {
        providerTurnId: "turn-1",
        outputTokens: 400,
        decodeMs: 9_000,
        tokensPerSecond: 44.4,
        turnMs: 20_000,
        firstTokenMs: 1_200,
      }
    : null;
}

it("shows usage and speed, and compacts from the popover", async () => {
  setup(36);
  const onCompact = vi.fn();
  await using screen = await render(
    <ComposerContextMeter
      environmentId={environmentId}
      threadId={threadId}
      compact={false}
      compactBlocker={null}
      onCompact={onCompact}
    />,
    { router: false }, // no navigation; the meter only renders popovers
  );
  await expect.element(screen.getByText("44 tok/s", { exact: false })).toBeVisible();

  await screen.getByRole("button", { name: "Context usage 36%" }).click();
  await expect.element(page.getByText("97,807 / 272,000 tokens")).toBeVisible();
  await expect.element(page.getByText("Compacts automatically at 70%")).toBeVisible();
  await expect.element(page.getByText("Last turn ~44 tok/s · first token 1.2s")).toBeVisible();

  await page.getByRole("button", { name: "Compact now" }).click();
  expect(onCompact).toHaveBeenCalledOnce();
});

it("opens on hover as well as on click", async () => {
  setup(36);
  await using screen = await render(
    <ComposerContextMeter
      environmentId={environmentId}
      threadId={threadId}
      compact={false}
      compactBlocker={null}
      onCompact={vi.fn()}
    />,
    { router: false }, // no navigation; the meter only renders popovers
  );
  await userEvent.hover(screen.getByRole("button", { name: "Context usage 36%" }));
  await expect.element(page.getByText("97,807 / 272,000 tokens")).toBeVisible();

  await userEvent.unhover(screen.getByRole("button", { name: "Context usage 36%" }));
  await userEvent.hover(screen.getByRole("button", { name: "~44 tok/s" }));
  await expect.element(page.getByText("Total time")).toBeVisible();
});

it("disables Compact now with the reason beside it, and keeps the ring alone when narrow", async () => {
  setup(83, "warning");
  await using screen = await render(
    <ComposerContextMeter
      environmentId={environmentId}
      threadId={threadId}
      compact
      compactBlocker="working"
      onCompact={vi.fn()}
    />,
    { router: false }, // no navigation; the meter only renders popovers
  );
  expect(screen.container.textContent).not.toContain("tok/s");
  expect(screen.container.textContent).not.toContain("83%");

  await screen.getByRole("button", { name: "Context usage 83%" }).click();
  await expect.element(page.getByRole("button", { name: "Compact now" })).toBeDisabled();
  await expect.element(page.getByText("Wait for the current turn to finish.")).toBeVisible();
});

it("renders nothing without data", async () => {
  state.ring = null;
  state.meter = null;
  state.speed = null;
  await using screen = await render(
    <ComposerContextMeter
      environmentId={environmentId}
      threadId={threadId}
      compact={false}
      compactBlocker={null}
      onCompact={vi.fn()}
    />,
    { router: false }, // no navigation; the meter only renders popovers
  );
  expect(screen.container.querySelector("[data-chat-composer-context-meter]")).toBeNull();
});
