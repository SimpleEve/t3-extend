import { createMemoryHistory } from "@tanstack/react-router";
import type { Editor } from "@tiptap/core";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform takes seconds; import it here.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  CODEX_PROVIDER,
  ENVIRONMENT_ID,
  dispatchedCommands,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

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

const SHORTCUTS = [
  shortcut("review", "Please $babysit this change", "Code review"),
  shortcut("summary", "Summarize the thread"),
  shortcut("babysit-last", "Run the checks and $babysit"),
];

// The app's shell subscription outlives a test, so each test opens a thread of its own.
async function openComposer(threadId: string) {
  // The ghost hint is for desktop-width composers; the default test viewport is a phone's.
  await page.viewport(1280, 800);
  const thread = threadWithHistory(threadId, 1);
  const environment = installFakeEnvironment([thread], {
    acceptCommands: true,
    providers: [
      {
        ...CODEX_PROVIDER,
        skills: [
          {
            name: "babysit",
            displayName: "Babysit PRs",
            path: "/skills/babysit/SKILL.md",
            enabled: true,
          },
        ],
      },
    ],
    settings: { promptShortcuts: SHORTCUTS },
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  const app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByText(`Answer 0 for ${threadId}.`)).toBeVisible();
  const editor = page.getByTestId("composer-editor");
  await userEvent.click(editor);
  return {
    editor,
    menu: () => document.querySelector("[data-composer-command-drawer]"),
    ghost: () => document.querySelector("[data-composer-ghost-text]"),
    proseMirror: () =>
      (document.querySelector(".tiptap") as (HTMLElement & { editor: Editor }) | null)!.editor,
    async [Symbol.asyncDispose]() {
      await app[Symbol.asyncDispose]();
      environment[Symbol.dispose]();
    },
  };
}

const sentMessageWith = (text: string) =>
  dispatchedCommands().some(
    (command) => command.type === "message.dispatch" && JSON.stringify(command).includes(text),
  );

it("typing ;name opens saved prompts, and Tab expands one into the composer with its skill as a chip", async () => {
  await using composer = await openComposer("thread-prompt-shortcut");
  const { editor, menu, ghost, proseMirror } = composer;

  // Times, URLs, a colon and a semicolon that start no name open no menu.
  await userEvent.keyboard("at 10:30 see http://x ; a;b :re ;zzz");
  expect(menu()).toBeNull();
  proseMirror().commands.clearContent(true);

  await userEvent.keyboard(";re");
  await expect.element(page.getByText(";review")).toBeVisible();
  expect(page.getByText(";summary").elements()).toHaveLength(0);
  // The menu and the ghost read the prompt, not its markup: the skill shows as its display name.
  await expect.element(page.getByText("Please Babysit PRs this change")).toBeVisible();
  // The ghost hints the rest of the name and a peek at the prompt, outside the document.
  await vi.waitFor(() =>
    expect(ghost()?.textContent).toBe("view — Please Babysit PRs this change"),
  );
  expect(proseMirror().state.doc.textContent).toBe(";re");

  await userEvent.keyboard("{Tab}");
  await vi.waitFor(() => expect(menu()).toBeNull());
  expect(ghost()).toBeNull();
  // `$babysit` renders as the same chip it is when typed, and the text around it stays editable.
  await expect.element(editor.getByText("Babysit PRs")).toBeVisible();
  expect(proseMirror().state.doc.textContent).not.toContain(";re");
  expect(proseMirror().state.doc.textContent).toContain("Please");
  await userEvent.keyboard("now");
  expect(proseMirror().state.doc.textContent).toContain("this change now");
});

it("Enter after ;D or ;) sends the message as typed, and ;re then Enter expands instead", async () => {
  await using composer = await openComposer("thread-prompt-shortcut-enter");
  const { editor, menu, proseMirror } = composer;

  // Nothing starts with "d", so the menu has no name to offer and Enter is a plain send.
  await userEvent.keyboard("lunch was good ;D{Enter}");
  await vi.waitFor(() => expect(sentMessageWith("lunch was good ;D")).toBe(true));
  expect(proseMirror().state.doc.textContent).not.toContain("Summarize");

  // "su" starts "summary": Enter expands it and sends nothing.
  const sentBefore = dispatchedCommands().length;
  await userEvent.click(editor);
  await userEvent.keyboard(";su{Enter}");
  await vi.waitFor(() => expect(menu()).toBeNull());
  expect(proseMirror().state.doc.textContent).toBe("Summarize the thread ");
  expect(dispatchedCommands()).toHaveLength(sentBefore);
});

it("a title or fuzzy match is offered from three characters, expands on Tab, and on Enter once an arrow key chose it", async () => {
  await using composer = await openComposer("thread-prompt-shortcut-fuzzy");
  const { editor, menu, proseMirror } = composer;

  // Two letters only match names that start with them.
  await userEvent.keyboard(";co");
  expect(menu()).toBeNull();
  proseMirror().commands.clearContent(true);

  // "cod" starts no name; it finds "review" through its title "Code review".
  await userEvent.keyboard(";cod");
  await expect.element(page.getByText(";review")).toBeVisible();
  // Nothing to complete, so there is no ghost either.
  expect(document.querySelector("[data-composer-ghost-text]")).toBeNull();
  await userEvent.keyboard("{Tab}");
  await vi.waitFor(() => expect(menu()).toBeNull());
  expect(proseMirror().state.doc.textContent).toContain("Please");
  proseMirror().commands.clearContent(true);

  // Enter alone sends the text; choosing the row with an arrow key is an explicit pick.
  await userEvent.keyboard(";cod{Enter}");
  await vi.waitFor(() => expect(sentMessageWith(";cod")).toBe(true));
  await userEvent.click(editor);
  await userEvent.keyboard(";cod");
  await expect.element(page.getByText(";review")).toBeVisible();
  await userEvent.keyboard("{ArrowDown}{Enter}");
  await vi.waitFor(() => expect(menu()).toBeNull());
  expect(proseMirror().state.doc.textContent).toContain("Please");
});

it("a shortcut that ends in a skill expands to a skill chip, and typing after it starts a new word", async () => {
  await using composer = await openComposer("thread-prompt-shortcut-skill-end");
  const { editor, proseMirror } = composer;

  await userEvent.keyboard(";babysit-l{Enter}");
  await expect.element(editor.getByText("Babysit PRs")).toBeVisible();
  expect(proseMirror().state.doc.textContent).not.toContain("$babysit");
  await userEvent.keyboard("soon");
  expect(proseMirror().state.doc.textContent).toMatch(/ soon$/);
});
