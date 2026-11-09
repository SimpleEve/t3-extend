import { loadUiCatalog, translatorFor } from "@t3tools/client-runtime/i18n";
import { projectScriptMenuLabel } from "@t3tools/shared/projectScripts";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import type { AppBarMenuItem } from "../components/ui/AppBar.types";
import { appBarMenuItemsFromActions } from "../components/ui/menuActionItems";
import { buildHomeListFilterMenuItems } from "../features/home/home-list-filter-menu";
import { localizeAppBarProps } from "./appBarI18n";

// Names that are also catalog keys: `server` is the project dev servers create for apps/server.
const COLLIDING = ["server", "Settings", "Done"] as const;

const t = translatorFor("zh-Hans");

beforeAll(async () => {
  await loadUiCatalog("zh-Hans");
});

const leaves = (items: ReadonlyArray<AppBarMenuItem>): ReadonlyArray<AppBarMenuItem> =>
  items.flatMap((item) => ("items" in item ? [item, ...leaves(item.items)] : [item]));

const shown = (items: ReadonlyArray<AppBarMenuItem>) =>
  localizeAppBarProps(
    {
      title: "Home",
      menus: [{ title: "Filter threads", icon: "line.3.horizontal.decrease", items }],
    },
    t,
  ).menus![0]!.items;

describe("the AppBar i18n wrapper", () => {
  it("shows the project and environment names in the home filter menu as they are", () => {
    const items = buildHomeListFilterMenuItems(
      {
        environments: COLLIDING.map((label, index) => ({
          environmentId: `env-${index}` as never,
          label,
        })),
        projects: COLLIDING.map((label) => ({ key: `project-${label}`, label })),
        selectedEnvironmentId: null,
        selectedProjectKey: null,
        onEnvironmentChange: () => {},
        onProjectChange: () => {},
      },
      t,
    );
    const titles = leaves(shown(items))
      .filter(
        (item) => item.id.startsWith("environment:env-") || item.id.startsWith("project:project-"),
      )
      .map((item) => item.title);
    expect(titles).toEqual([...COLLIDING, ...COLLIDING]);
  });

  it("shows menu actions that a screen already localized as they are", () => {
    const items = appBarMenuItemsFromActions(
      COLLIDING.map((title) => ({ id: title, title, subtitle: "server" })),
      () => {},
    );
    expect(
      leaves(shown(items)).map((item) => [item.title, "subtitle" in item && item.subtitle]),
    ).toEqual(COLLIDING.map((title) => [title, "server"]));
  });

  it("still translates the copy a screen leaves to it", () => {
    const [environment, project] = shown([
      {
        id: "a",
        title: "Environment",
        subtitle: "Show threads from every project",
        onPress: () => {},
      },
      { id: "b", title: "Project", verbatim: true, onPress: () => {} },
    ]);
    expect(environment).toMatchObject({ title: "环境", subtitle: "显示所有项目的对话" });
    expect(project).toMatchObject({ title: "Project" });
  });

  it("shows a name with its translated role or marker, which the screen built itself", () => {
    const [script, project] = shown([
      {
        id: "script",
        title: projectScriptMenuLabel(
          {
            id: "s",
            name: "server",
            command: "x",
            icon: "play",
            runOnWorktreeCreate: true,
            runOnSettle: true,
          },
          t,
        ),
        verbatim: true,
        onPress: () => {},
      },
      { id: "project", title: `server · ${t("Archived")}`, verbatim: true, onPress: () => {} },
    ]);
    expect(script).toMatchObject({ title: "server (创建 worktree 时、标为已处理时)" });
    expect(project).toMatchObject({ title: "server · 已归档" });
  });
});
