import type { EnvironmentId } from "@t3tools/contracts";
import type { Translator } from "@t3tools/client-runtime/i18n"; // fork: i18n
import type { SidebarViewMode } from "@t3tools/client-runtime/state/thread-grouping"; // fork: thread list views

export interface HomeListFilterMenuEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export interface HomeListFilterMenuProject {
  readonly key: string;
  readonly label: string;
}

type HomeListFilterMenuAction = {
  readonly type: "action";
  readonly title: string;
  readonly subtitle?: string;
  readonly state?: "on" | "off";
  readonly onPress: () => void;
};

type HomeListFilterMenuSubmenu = {
  readonly type: "submenu";
  readonly title: string;
  readonly items: HomeListFilterMenuAction[];
};

export interface HomeListFilterMenu {
  readonly title: string;
  readonly items: Array<HomeListFilterMenuAction | HomeListFilterMenuSubmenu>;
}

export function buildHomeListFilterMenu(
  props: {
    readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
    readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
    readonly selectedEnvironmentId: EnvironmentId | null;
    readonly selectedProjectKey: string | null;
    readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
    readonly onProjectChange: (projectKey: string | null) => void;
    // fork: thread list views
    readonly viewMode?: SidebarViewMode;
    readonly onViewModeChange?: (viewMode: SidebarViewMode) => void;
  },
  t: Translator,
): HomeListFilterMenu {
  const items: Array<HomeListFilterMenuAction | HomeListFilterMenuSubmenu> = [];

  // fork: thread list views
  const { viewMode, onViewModeChange } = props;
  if (viewMode !== undefined && onViewModeChange !== undefined) {
    items.push({
      type: "submenu",
      title: t("Group threads"),
      items: (["status", "project"] as const).map((mode) => ({
        type: "action" as const,
        title: mode === "status" ? t("By status") : t("By project"),
        state: viewMode === mode ? ("on" as const) : ("off" as const),
        onPress: () => onViewModeChange(mode),
      })),
    });
  }

  items.push({
    type: "submenu",
    title: t("Environment"),
    items: [
      {
        type: "action",
        title: t("All environments"),
        subtitle: t("Show threads from every environment"),
        state: props.selectedEnvironmentId === null ? "on" : "off",
        onPress: () => props.onEnvironmentChange(null),
      },
      ...props.environments.map((environment) => ({
        type: "action" as const,
        title: environment.label,
        state:
          props.selectedEnvironmentId === environment.environmentId
            ? ("on" as const)
            : ("off" as const),
        onPress: () => props.onEnvironmentChange(environment.environmentId),
      })),
    ],
  });

  if (props.projects.length > 0) {
    items.push({
      type: "submenu",
      title: t("Project"),
      items: [
        {
          type: "action",
          title: t("All projects"),
          subtitle: t("Show threads from every project"),
          state: props.selectedProjectKey === null ? "on" : "off",
          onPress: () => props.onProjectChange(null),
        },
        ...props.projects.map((project) => ({
          type: "action" as const,
          title: project.label,
          state: props.selectedProjectKey === project.key ? ("on" as const) : ("off" as const),
          onPress: () => props.onProjectChange(project.key),
        })),
      ],
    });
  }

  return {
    title: t("Thread list options"),
    items,
  };
}
