import "~/index.css";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ComposerContextMeter } from "./ComposerContextMeter";

const meter = {
  percent: 36,
  usedTokens: 97_807,
  maxTokens: 272_000,
  tone: null,
  autoCompactPercent: 70,
} as const;
const speed = {
  providerTurnId: "turn-1",
  outputTokens: 400,
  decodeMs: 9_000,
  tokensPerSecond: 44.4,
  turnMs: 20_000,
  firstTokenMs: 1_200,
} as const;

it("shows usage and speed, and compacts from the popover", async () => {
  const onCompact = vi.fn();
  await using screen = await render(
    <ComposerContextMeter
      meter={meter}
      speed={speed}
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

it("disables Compact now and keeps the ring alone when narrow", async () => {
  await using screen = await render(
    <ComposerContextMeter
      meter={{ ...meter, tone: "warning", percent: 83 }}
      speed={speed}
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
});

it("renders nothing without data", async () => {
  await using screen = await render(
    <ComposerContextMeter
      meter={null}
      speed={null}
      compact={false}
      compactBlocker={null}
      onCompact={vi.fn()}
    />,
    { router: false }, // no navigation; the meter only renders popovers
  );
  expect(screen.container.querySelector("[data-chat-composer-context-meter]")).toBeNull();
});
