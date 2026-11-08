import type { EnvironmentId } from "@t3tools/contracts";
import type { Translator } from "@t3tools/client-runtime/i18n"; // fork: i18n
import type { SidebarViewMode } from "@t3tools/client-runtime/state/thread-grouping"; // fork: thread list views

import type { AppBarMenuItem } from "../../components/ui/AppBar.types";

export interface HomeListFilterMenuEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export interface HomeListFilterMenuProject {
  readonly key: string;
  readonly label: string;
}

export function buildHomeListFilterMenuItems(
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
  t: Translator, // fork: i18n
): AppBarMenuItem[] {
  const items: AppBarMenuItem[] = [
    {
      id: "environment",
      title: t("Environment"),
      items: [
        {
          id: "environment:all",
          title: t("All environments"),
          subtitle: t("Show threads from every environment"),
          selected: props.selectedEnvironmentId === null,
          onPress: () => props.onEnvironmentChange(null),
        },
        ...props.environments.map((environment) => ({
          id: `environment:${environment.environmentId}`,
          title: environment.label,
          selected: props.selectedEnvironmentId === environment.environmentId,
          onPress: () => props.onEnvironmentChange(environment.environmentId),
        })),
      ],
    },
  ];

  if (props.projects.length > 0) {
    items.push({
      id: "project",
      title: t("Project"),
      items: [
        {
          id: "project:all",
          title: t("All projects"),
          subtitle: t("Show threads from every project"),
          selected: props.selectedProjectKey === null,
          onPress: () => props.onProjectChange(null),
        },
        ...props.projects.map((project) => ({
          id: `project:${project.key}`,
          title: project.label,
          selected: props.selectedProjectKey === project.key,
          onPress: () => props.onProjectChange(project.key),
        })),
      ],
    });
  }

  // fork: thread list views
  const { viewMode, onViewModeChange } = props;
  if (viewMode !== undefined && onViewModeChange !== undefined) {
    items.unshift({
      id: "view",
      title: t("Group threads"),
      items: (["status", "project"] as const).map((mode) => ({
        id: `view:${mode}`,
        title: mode === "status" ? t("By status") : t("By project"),
        selected: viewMode === mode,
        onPress: () => onViewModeChange(mode),
      })),
    });
  }

  return items;
}
