import { FORK_THEME_BACKGROUND_WS_METHODS } from "@t3tools/contracts";

import { issueThemeBackgroundUploadUrl } from "./upload.ts";

/** Handlers for the `themeBackgrounds.*` RPCs. */
export const themeBackgroundRpcHandlers = {
  [FORK_THEME_BACKGROUND_WS_METHODS.createUploadUrl]: issueThemeBackgroundUploadUrl,
};
