import type { Catalog } from "../../translate.ts";
import appearance from "./appearance.ts";
import chat from "./chat.ts";
import commandPalette from "./commandPalette.ts";
import common from "./common.ts";
import desktop from "./desktop.ts";
import mobileBrowser from "./mobileBrowser.ts";
import settings from "./settings.ts";
import sharing from "./sharing.ts";
import sidebar from "./sidebar.ts";
import time from "./time.ts";
import workspace from "./workspace.ts";

// One file per area so parallel translation work rarely touches the same file.
// A key in two areas must translate the same; the catalog test rejects conflicts.
export const ZH_HANS_AREAS: Readonly<Record<string, Catalog>> = {
  appearance,
  chat,
  commandPalette,
  common,
  desktop,
  mobileBrowser,
  settings,
  sharing,
  sidebar,
  time,
  workspace,
};

const catalog: Catalog = Object.assign({}, ...Object.values(ZH_HANS_AREAS));
export default catalog;
