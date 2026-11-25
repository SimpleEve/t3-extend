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
  settingsPatchesSent,
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

const savedNames = () => {
  const patch = settingsPatchesSent().at(-1) as
    | { promptShortcuts: ReadonlyArray<{ name: string; title: string | null; content: string }> }
    | undefined;
  return patch?.promptShortcuts;
};

it("lists, creates, edits and deletes prompt shortcuts, checking names as they are typed", async () => {
  await page.viewport(1280, 800);
  const thread = threadWithHistory("thread-shortcut-settings", 1);
  using _environment = installFakeEnvironment([thread], {
    settings: {
      promptShortcuts: [
        {
          id: "shortcut-review",
          name: "review",
          title: "Code review",
          content: "Review this change",
          createdAt: "2026-11-25T00:00:00.000Z",
          updatedAt: "2026-11-25T00:00:00.000Z",
        },
      ],
    },
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(createMemoryHistory({ initialEntries: ["/settings/prompt-shortcuts"] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByText(":review", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Code review")).toBeVisible();

  // Create: a taken name is refused as it is typed.
  await page.getByRole("button", { name: "New shortcut" }).click();
  const name = page.getByRole("textbox", { name: "Name" });
  await name.fill("Review");
  await expect.element(page.getByText("Another shortcut is already named :review.")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await name.fill("fix ci");
  await expect
    .element(page.getByText("Use lowercase letters, numbers and hyphens only."))
    .toBeVisible();
  await name.fill("Fix-CI");
  await page.getByRole("textbox", { name: "Prompt" }).click();
  await page.getByRole("textbox", { name: "Prompt" }).fill("Fix the failing CI job");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await vi.waitFor(() =>
    expect(savedNames()?.map((entry) => entry.name)).toEqual(["review", "fix-ci"]),
  );
  expect(savedNames()?.[1]?.content).toBe("Fix the failing CI job");
  await expect.element(page.getByText(":fix-ci", { exact: true })).toBeVisible();

  // Edit: the title changes, the name stays.
  await page.getByRole("button", { name: "Edit :fix-ci" }).click();
  await page.getByRole("textbox", { name: /^Title/ }).fill("CI green");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await vi.waitFor(() => expect(savedNames()?.[1]?.title).toBe("CI green"));
  expect(savedNames()).toHaveLength(2);

  // Delete: removed at once, with an Undo that puts it back.
  await page.getByRole("button", { name: "Delete :fix-ci" }).click();
  await vi.waitFor(() => expect(savedNames()?.map((entry) => entry.name)).toEqual(["review"]));
  await expect.element(page.getByText(":fix-ci", { exact: true })).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Undo" }).click();
  await vi.waitFor(() =>
    expect(savedNames()?.map((entry) => entry.name)).toEqual(["review", "fix-ci"]),
  );
});
