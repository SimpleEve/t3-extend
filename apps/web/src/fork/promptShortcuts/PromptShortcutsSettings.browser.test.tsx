import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "../../index.css";
import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  installFakeEnvironment,
  servedSettings,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";

vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const shortcut = (name: string, content: string, title: string | null = null) => ({
  id: `shortcut-${name}`,
  name,
  title,
  content,
  createdAt: "2026-11-25T00:00:00.000Z",
  updatedAt: "2026-11-25T00:00:00.000Z",
});

const savedNames = () => servedSettings().promptShortcuts.map((entry) => entry.name);
const WAIT = { timeout: 8000 };
// Other toasts stack over the Undo button and take its clicks, so press it directly.
const pressUndo = () =>
  vi.waitFor(() => {
    const undo = document.querySelector<HTMLButtonElement>('[data-slot="toast-action"]');
    expect(undo).not.toBeNull();
    undo!.click();
  }, WAIT);

async function openSettings(
  threadId: string,
  promptShortcuts: ReadonlyArray<ReturnType<typeof shortcut>>,
) {
  await page.viewport(1280, 800);
  const thread = threadWithHistory(threadId, 1);
  const environment = installFakeEnvironment([thread], {
    settings: { promptShortcuts },
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(createMemoryHistory({ initialEntries: ["/settings/prompt-shortcuts"] }));
  await router.load();
  const app = await render(<AppRoot router={router} />, { router: false });
  return {
    async [Symbol.asyncDispose]() {
      await app[Symbol.asyncDispose]();
      environment[Symbol.dispose]();
    },
  };
}

// One flow: the app keeps the first test's settings for the rest of a file, so scenarios that need
// their own settings would see stale ones.
it("lists, creates, edits and deletes prompt shortcuts, keeping fast deletes and undo safe", async () => {
  await using _app = await openSettings("thread-shortcut-settings", [
    shortcut("review", "Review this change", "Code review"),
    shortcut("alpha", "A"),
    shortcut("beta", "B"),
  ]);
  await expect.element(page.getByText(";review", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Code review")).toBeVisible();
  // Shortcuts belong to a machine, not a project: the page offers only the machine to choose.
  await expect.element(page.getByRole("button", { name: /^Environment scope/ })).toBeVisible();
  expect(page.getByRole("button", { name: /^Project scope/ }).elements()).toHaveLength(0);

  // Create: a taken name is refused as it is typed.
  await page.getByRole("button", { name: "New shortcut" }).click();
  const name = page.getByRole("textbox", { name: "Name" });
  await name.fill("Review");
  await expect.element(page.getByText("Another shortcut is already named ;review.")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await name.fill("fix ci");
  await expect
    .element(page.getByText("Use lowercase letters, numbers and hyphens only."))
    .toBeVisible();
  await name.fill(";Fix-CI");
  // Opened from Settings there is no workspace, so only `$` is on offer in the hint.
  await expect.element(page.getByText("Write the prompt. Type $ for skills.")).toBeInTheDocument();
  await page.getByRole("textbox", { name: "Prompt" }).click();
  await page.getByRole("textbox", { name: "Prompt" }).fill("Fix the failing CI job");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await vi.waitFor(() => expect(savedNames()).toEqual(["review", "alpha", "beta", "fix-ci"]), WAIT);
  expect(servedSettings().promptShortcuts[3]?.content).toBe("Fix the failing CI job");
  await expect.element(page.getByText(";fix-ci", { exact: true })).toBeVisible();

  // Edit: the title changes, the name stays.
  await page.getByRole("button", { name: "Edit ;fix-ci" }).click();
  await page.getByRole("textbox", { name: /^Title/ }).fill("CI green");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await vi.waitFor(() => expect(servedSettings().promptShortcuts[3]?.title).toBe("CI green"), WAIT);
  expect(savedNames()).toHaveLength(4);

  // Delete: removed at once, with an Undo that puts it back.
  await page.getByRole("button", { name: "Delete ;fix-ci" }).click();
  await vi.waitFor(() => expect(savedNames()).toEqual(["review", "alpha", "beta"]), WAIT);
  await expect.element(page.getByText(";fix-ci", { exact: true })).not.toBeInTheDocument();
  await pressUndo();
  await vi.waitFor(() => expect(savedNames()).toEqual(["review", "alpha", "beta", "fix-ci"]), WAIT);

  // Undo does not overwrite a shortcut that took the name meanwhile.
  await page.getByRole("button", { name: "Delete ;fix-ci" }).click();
  await vi.waitFor(() => expect(savedNames()).toEqual(["review", "alpha", "beta"]), WAIT);
  await page.getByRole("button", { name: "New shortcut" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("fix-ci");
  await page.getByRole("textbox", { name: "Prompt" }).click();
  await page.getByRole("textbox", { name: "Prompt" }).fill("New text");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await vi.waitFor(() => expect(savedNames()).toEqual(["review", "alpha", "beta", "fix-ci"]), WAIT);
  await pressUndo();
  await expect.element(page.getByText("Prompt shortcut not restored")).toBeVisible();
  expect(servedSettings().promptShortcuts.at(-1)?.content).toBe("New text");

  // Two deletes in quick succession both stick: each is applied to the stored list, not to a copy.
  const deleteButton = (name: string) =>
    document.querySelector(`button[aria-label="Delete ;${name}"]`) as HTMLButtonElement;
  await expect.element(deleteButton("alpha")).toBeEnabled();
  deleteButton("alpha").click();
  deleteButton("beta").click();
  await vi.waitFor(() => expect(savedNames()).toEqual(["review", "fix-ci"]), WAIT);
  await expect.element(page.getByText(";alpha", { exact: true })).not.toBeInTheDocument();
  await expect.element(page.getByText(";beta", { exact: true })).not.toBeInTheDocument();
});
