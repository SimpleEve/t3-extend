import type { RunId, ScopedThreadRef } from "@t3tools/contracts";
import type { RunOutputs } from "@t3tools/client-runtime/outputs/run";
import { EMPTY_THREAD_OUTPUTS, type ThreadOutputs } from "@t3tools/client-runtime/outputs/thread";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../../test/render";

const mocks = vi.hoisted(() => ({
  run: { files: [], links: [] } as RunOutputs,
  thread: { files: [], links: [], byRunId: new Map() } as ThreadOutputs,
  runFileAction: vi.fn(),
  runLinkAction: vi.fn(),
  showFileMenu: vi.fn(async () => undefined),
  showLinkMenu: vi.fn(async () => undefined),
  previewable: true,
}));

vi.mock("~/state/outputs", () => ({
  useRunOutputs: () => mocks.run,
  useThreadOutputs: () => mocks.thread,
}));

vi.mock("./useOutputActions", () => ({
  useOutputActions: () => ({
    primaryFileAction: () => (mocks.previewable ? "preview" : null),
    primaryLinkAction: () => "preview",
    runFileAction: mocks.runFileAction,
    runLinkAction: mocks.runLinkAction,
    showFileMenu: mocks.showFileMenu,
    showLinkMenu: mocks.showLinkMenu,
  }),
}));

import { TimelineRowCtx } from "../timelineRowContext";
import { AssistantOutputsStrip } from "./AssistantOutputsStrip";
import { ThreadOutputsButton } from "./ThreadOutputsButton";

const THREAD_REF = { environmentId: "env", threadId: "thread" } as unknown as ScopedThreadRef;
const RUN_ID = "run-1" as RunId;

function setup(input: { files?: string[]; links?: string[]; previewable?: boolean }) {
  const files = (input.files ?? []).map((path) => ({
    path,
    source: "changed" as const,
    runId: RUN_ID,
  }));
  const links = (input.links ?? []).map((url) => ({ url, runId: RUN_ID }));
  mocks.run = { files, links };
  mocks.thread = { ...EMPTY_THREAD_OUTPUTS, files, links, byRunId: new Map() };
  mocks.previewable = input.previewable ?? true;
  mocks.runFileAction.mockClear();
  mocks.runLinkAction.mockClear();
  mocks.showFileMenu.mockClear();
  mocks.showLinkMenu.mockClear();
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

const manyFiles = (count: number) =>
  Array.from({ length: count }, (_, index) => `/work/app/src/file-${index}.ts`);

describe("AssistantOutputsStrip", () => {
  it("lists files with their folder and links with host and path, and runs the primary action on click", async () => {
    setup({ files: ["/work/app/src/ui/a.ts"], links: ["http://localhost:3000/app"] });
    await using screen = await render(strip, { router: false });

    await expect.element(screen.getByText("a.ts")).toBeVisible();
    await expect.element(screen.getByText("src/ui")).toBeVisible();
    await expect.element(screen.getByText("localhost:3000")).toBeVisible();
    await expect.element(screen.getByText("/app")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: /a\.ts/ }).first());
    expect(mocks.runFileAction).toHaveBeenCalledWith(
      "preview",
      expect.objectContaining({ path: "/work/app/src/ui/a.ts" }),
    );
    await userEvent.click(screen.getByRole("button", { name: /localhost:3000/ }).first());
    expect(mocks.runLinkAction).toHaveBeenCalledWith(
      "preview",
      expect.objectContaining({ url: "http://localhost:3000/app" }),
    );
  });

  it("opens the menu from the more button without running the primary action", async () => {
    setup({ files: ["/tmp/report.md"] });
    await using screen = await render(strip, { router: false });
    await userEvent.click(screen.getByRole("button", { name: "More actions for report.md" }));
    expect(mocks.showFileMenu).toHaveBeenCalledTimes(1);
    expect(mocks.runFileAction).not.toHaveBeenCalled();
  });

  it("keeps a file that cannot be previewed as a row with a menu only", async () => {
    setup({ files: ["/tmp/report.md"], previewable: false });
    await using screen = await render(strip, { router: false });
    await expect.element(screen.getByRole("button", { name: /report\.md/ }).first()).toBeDisabled();
    await expect
      .element(screen.getByRole("button", { name: "More actions for report.md" }))
      .toBeEnabled();
  });

  it("shows six rows, then the rest on request", async () => {
    setup({ files: manyFiles(9) });
    await using screen = await render(strip, { router: false });
    expect(screen.container.querySelectorAll("[data-output-kind='file']")).toHaveLength(6);
    await userEvent.click(screen.getByRole("button", { name: "Show 3 more" }));
    expect(screen.container.querySelectorAll("[data-output-kind='file']")).toHaveLength(9);
    expect(screen.container.textContent).not.toContain("Show 3 more");
  });

  it("renders nothing for a run without outputs", async () => {
    setup({});
    await using screen = await render(strip, { router: false });
    expect(screen.container.querySelector("[data-assistant-outputs]")).toBeNull();
  });
});

describe("ThreadOutputsButton", () => {
  const button = <ThreadOutputsButton threadRef={THREAD_REF} workspaceRoot="/work/app" />;

  it("is absent while the conversation has no outputs", async () => {
    setup({});
    await using screen = await render(button, { router: false });
    expect(screen.container.querySelector("[data-thread-outputs-button]")).toBeNull();
  });

  it("counts every output and opens a popover with a files and a links section, each cut at six", async () => {
    setup({ files: manyFiles(8), links: ["http://localhost:3000", "https://example.com/x"] });
    await using screen = await render(button, { router: false });

    const trigger = screen.container.querySelector("[data-thread-outputs-button]");
    expect(trigger?.textContent).toContain("10");
    await userEvent.click(page.getByRole("button", { name: "Outputs" }));

    await expect.element(page.getByRole("heading", { name: /Files/ })).toBeVisible();
    await expect.element(page.getByRole("heading", { name: /Links/ })).toBeVisible();
    expect(document.querySelectorAll("[data-output-kind='file']")).toHaveLength(6);
    expect(document.querySelectorAll("[data-output-kind='link']")).toHaveLength(2);

    await userEvent.click(page.getByRole("button", { name: "Show 2 more" }));
    expect(document.querySelectorAll("[data-output-kind='file']")).toHaveLength(8);

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(document.querySelector("[data-outputs-section]")).toBeNull());
  });
});
