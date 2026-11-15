import { translatorFor, type Translator } from "@t3tools/client-runtime/i18n"; // fork: interface language
import { isWorkspaceCatalogPending, type WorkspaceState } from "../../state/workspaceModel";

export interface HomeEmptyState {
  readonly title: string;
  readonly detail: string;
  readonly loading: boolean;
  readonly showsAddEnvironment: boolean;
}

export function deriveHomeEmptyState(
  catalogState: WorkspaceState,
  projectCount: number,
  t: Translator = translatorFor("en"), // fork: interface language
): HomeEmptyState {
  const emptyState = deriveEmptyState(catalogState, projectCount, t);
  return {
    ...emptyState,
    showsAddEnvironment: !emptyState.loading && !catalogState.hasReadyEnvironment,
  };
}

function deriveEmptyState(
  catalogState: WorkspaceState,
  projectCount: number,
  t: Translator,
): Omit<HomeEmptyState, "showsAddEnvironment"> {
  if (catalogState.isLoadingConnections) {
    return {
      title: t("Loading environments"),
      detail: t("Checking saved environments on this device."),
      loading: true,
    };
  }

  if (!catalogState.hasConnections) {
    return {
      title: t("No environments connected"),
      detail: t("Add an environment to load projects and start coding sessions."),
      loading: false,
    };
  }

  if (
    (catalogState.connectionState === "available" ||
      catalogState.connectionState === "offline" ||
      catalogState.connectionState === "error" ||
      catalogState.connectionState === "unsupported") &&
    !catalogState.hasLoadedShellSnapshot
  ) {
    return {
      title:
        catalogState.connectionState === "unsupported"
          ? t("Client not supported")
          : t("Environment unavailable"),
      detail:
        catalogState.connectionError ??
        t("The saved environment is offline. Check the URL or start the environment, then retry."),
      loading: false,
    };
  }

  if (isWorkspaceCatalogPending(catalogState)) {
    return {
      title: catalogState.hasReadyEnvironment
        ? t("Loading threads")
        : t("Connecting to environment"),
      detail: t("Loading projects and threads from the saved environment."),
      loading: true,
    };
  }

  if (projectCount === 0 && catalogState.hasLoadedShellSnapshot) {
    return {
      title: t("No projects found"),
      detail: t("The connected environment did not report any projects."),
      loading: false,
    };
  }

  return {
    title: t("No threads yet"),
    detail: t("Create a task to start a new coding runtime in one of your connected projects."),
    loading: false,
  };
}
