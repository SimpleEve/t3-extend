import type { RunId, ScopedThreadRef } from "@t3tools/contracts";
import type { RunOutputs } from "@t3tools/client-runtime/outputs/run";
import { EMPTY_THREAD_OUTPUTS, type ThreadOutputs } from "@t3tools/client-runtime/outputs/thread";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../../test/render";

const mocks = vi.hoisted(() => ({
  run: { files: [], links: [] } as RunOutputs,
  thread: {
    files: [],
    links: [],
    filesTotal: 0,
    linksTotal: 0,
    byRunId: new Map(),
  } as ThreadOutputs,
}));

vi.mock("~/state/outputs", () => ({
  useRunOutputs: () => mocks.run,
  useThreadOutputs: () => mocks.thread,
}));

vi.mock("./useOutputActions", () => ({
  useOutputActions: () => ({
    primaryFileAction: () => "preview",
    primaryLinkAction: () => "preview",
    runFileAction: vi.fn(),
    runLinkAction: vi.fn(),
    showFileMenu: vi.fn(async () => undefined),
    showLinkMenu: vi.fn(async () => undefined),
  }),
}));

import { TimelineRowCtx } from "../timelineRowContext";
import { AssistantOutputsStrip } from "./AssistantOutputsStrip";
import { ThreadOutputsButton } from "./ThreadOutputsButton";

const THREAD_REF = { environmentId: "env", threadId: "thread" } as unknown as ScopedThreadRef;
const RUN_ID = "run-1" as RunId;

const manyFiles = (count: number) =>
  Array.from({ length: count }, (_, index) => `/work/app/src/file-${index}.ts`);

/** `filesTotal` and `linksTotal` default to what is listed; a larger value means a cut list. */
function setup(input: {
  files?: string[];
  links?: string[];
  filesTotal?: number;
  linksTotal?: number;
}) {
  const files = (input.files ?? []).map((path) => ({
    path,
    source: "changed" as const,
    runId: RUN_ID,
  }));
  const links = (input.links ?? []).map((url) => ({ url, runId: RUN_ID }));
  mocks.run = { files, links };
  mocks.thread = {
    ...EMPTY_THREAD_OUTPUTS,
    files,
    links,
    filesTotal: input.filesTotal ?? files.length,
    linksTotal: input.linksTotal ?? links.length,
  };
}

const strip = (
  <TimelineRowCtx
    value={
      {
        threadRef: THREAD_REF,
        workspaceRoot: "/work/app",
        resolvedTheme: "light",
      } as never
    }
  >
    <AssistantOutputsStrip runId={RUN_ID} />
  </TimelineRowCtx>
);

const fileRows = (root: ParentNode) => root.querySelectorAll("[data-output-kind='file']");
const linkRows = (root: ParentNode) => root.querySelectorAll("[data-output-kind='link']");

describe("AssistantOutputsStrip", () => {
  it("lists files with their folder and links with host and path", async () => {
    setup({ files: ["/work/app/src/ui/a.ts"], links: ["http://localhost:3000/app"] });
    await using screen = await render(strip);

    await expect.element(screen.getByText("a.ts")).toBeVisible();
    await expect.element(screen.getByText("src/ui")).toBeVisible();
    await expect.element(screen.getByText("localhost:3000")).toBeVisible();
    await expect.element(screen.getByText("/app")).toBeVisible();
  });

  it("shows six rows, then the rest on request", async () => {
    setup({ files: manyFiles(9) });
    await using screen = await render(strip);
    expect(fileRows(screen.container)).toHaveLength(6);
    await userEvent.click(screen.getByRole("button", { name: "Show 3 more" }));
    expect(fileRows(screen.container)).toHaveLength(9);
    expect(screen.container.textContent).not.toContain("Show 3 more");
  });

  it("says how many a long run left out instead of dropping them silently", async () => {
    setup({ files: manyFiles(130) });
    await using screen = await render(strip);
    // The header counts everything the run produced; the list stops at its limit.
    expect(screen.container.querySelector("[data-assistant-outputs]")?.textContent).toContain(
      "Outputs 130",
    );
    await userEvent.click(screen.getByRole("button", { name: "Show 94 more" }));
    expect(fileRows(screen.container)).toHaveLength(100);
    await expect.element(screen.getByText("30 more not listed")).toBeVisible();
  });

  it("renders nothing for a run without outputs", async () => {
    setup({});
    await using screen = await render(strip);
    expect(screen.container.querySelector("[data-assistant-outputs]")).toBeNull();
  });
});

describe("ThreadOutputsButton", () => {
  const button = <ThreadOutputsButton threadRef={THREAD_REF} workspaceRoot="/work/app" />;
  const trigger = (root: ParentNode) => root.querySelector("[data-thread-outputs-button]");

  it("is absent while the conversation has no outputs", async () => {
    setup({});
    await using screen = await render(button);
    expect(trigger(screen.container)).toBeNull();
  });

  it("counts the real total and matches the headings of the lists it opens", async () => {
    setup({
      files: manyFiles(8),
      links: ["http://localhost:3000", "https://example.com/x"],
      filesTotal: 350,
      linksTotal: 120,
    });
    await using screen = await render(button);
    expect(trigger(screen.container)?.textContent).toContain("470");

    await userEvent.click(page.getByRole("button", { name: "Outputs" }));
    await expect.element(page.getByRole("heading", { name: "Files 350" })).toBeVisible();
    await expect.element(page.getByRole("heading", { name: "Links 120" })).toBeVisible();
    await expect.element(page.getByText("342 more not listed")).toBeVisible();
    await expect.element(page.getByText("118 more not listed")).toBeVisible();
  });

  it("opens with six rows per section, expands, and closes on Escape", async () => {
    setup({ files: manyFiles(8), links: ["http://localhost:3000", "https://example.com/x"] });
    await using _screen = await render(button);

    await userEvent.click(page.getByRole("button", { name: "Outputs" }));
    await expect.element(page.getByRole("heading", { name: "Files 8" })).toBeVisible();
    expect(fileRows(document)).toHaveLength(6);
    expect(linkRows(document)).toHaveLength(2);

    await userEvent.click(page.getByRole("button", { name: "Show 2 more" }));
    expect(fileRows(document)).toHaveLength(8);

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(document.querySelector("[data-outputs-section]")).toBeNull());
  });

  it("leaves focus on the trigger, so no row's path tooltip covers the headings", async () => {
    setup({ files: manyFiles(3) });
    await using screen = await render(button);

    await userEvent.click(page.getByRole("button", { name: "Outputs" }));
    await expect.element(page.getByRole("heading", { name: "Files 3" })).toBeVisible();
    const popup = document.querySelector("[data-slot='popover-popup']");
    expect(popup?.contains(document.activeElement)).toBe(false);
    expect(document.activeElement).toBe(trigger(screen.container));
  });
});
