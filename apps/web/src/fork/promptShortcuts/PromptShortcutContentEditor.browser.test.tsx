import { createMemoryHistory } from "@tanstack/react-router";
import type { Editor } from "@tiptap/core";
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
  CODEX_PROVIDER,
  installFakeEnvironment,
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

const promptEditor = () =>
  (document.querySelector("[role=dialog] .tiptap") as (HTMLElement & { editor: Editor }) | null)!
    .editor;

// Both scenarios share the app's settings, which stay as the first test left them.
async function openSettings() {
  await page.viewport(1280, 800);
  const thread = threadWithHistory("thread-shortcut-editor", 1);
  const environment = installFakeEnvironment([thread], {
    providers: [
      {
        ...CODEX_PROVIDER,
        skills: [{ name: "babysit", path: "/skills/babysit/SKILL.md", enabled: true }],
      },
    ],
    settings: {
      promptShortcuts: [
        {
          id: "shortcut-close-out",
          name: "close-out",
          title: null,
          content: "Wrap up with $babysit",
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
  const app = await render(<AppRoot router={router} />, { router: false });
  return {
    async [Symbol.asyncDispose]() {
      await app[Symbol.asyncDispose]();
      environment[Symbol.dispose]();
    },
  };
}

it("keeps the text in order when later insertions land before the first has rendered", async () => {
  await using _app = await openSettings();
  await page.getByRole("button", { name: "New shortcut" }).click();
  await page.getByRole("textbox", { name: "Prompt" }).click();
  const editor = promptEditor();

  // Paste speed: the chunks arrive in one task, so React has committed none of them.
  editor.commands.insertContent("Line one for demo.\nLook at @math");
  editor.commands.insertContent(". Line three uses more text");

  await vi.waitFor(() =>
    expect(editor.getText({ blockSeparator: "\n" })).toBe(
      "Line one for demo.\nLook at @math. Line three uses more text",
    ),
  );
  await page.getByRole("button", { name: "Cancel" }).click();
});

it("opens a saved prompt that ends in a skill with the skill as a chip", async () => {
  await using _app = await openSettings();
  await page.getByRole("button", { name: "Edit ;close-out" }).click();
  await expect
    .element(page.getByRole("dialog").getByText("babysit", { exact: true }))
    .toBeVisible();
  expect(promptEditor().getText()).not.toContain("$babysit");
});
