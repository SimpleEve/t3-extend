import type { Catalog } from "../../translate.ts";
import appearance from "./appearance.ts";
import clientErrors from "./clientErrors.ts";
import chat from "./chat.ts";
import commandPalette from "./commandPalette.ts";
import common from "./common.ts";
import connection from "./connection.ts";
import contextMeter from "./contextMeter.ts"; // fork: context meter
import desktop from "./desktop.ts";
import devices from "./devices.ts"; // fork: self-hosted devices
import footer from "./footer.ts";
import loopbackGateway from "./loopbackGateway.ts"; // fork: remote loopback forwarding
import mcpConnect from "./mcpConnect.ts"; // fork: MCP connect and linking
import mobile from "./mobile.ts";
import mobileBrowser from "./mobileBrowser.ts";
import mobilePullRequests from "./mobilePullRequests.ts";
import mobilePush from "./mobilePush.ts";
import mobileSettings from "./mobileSettings.ts";
import mobileWorkspace from "./mobileWorkspace.ts";
import outputs from "./outputs.ts"; // fork: outputs
import pullRequest from "./pullRequest.ts";
import settings from "./settings.ts";
import settingsPanels from "./settingsPanels.ts";
import sharing from "./sharing.ts";
import sidebar from "./sidebar.ts";
import storageCleanup from "./storageCleanup.ts";
import t3Tools from "./t3Tools.ts";
import themeStudio from "./themeStudio.ts"; // fork: theme studio
import time from "./time.ts";
import voice from "./voice.ts"; // fork: voice input
import workspace from "./workspace.ts";

// One file per area so parallel translation work rarely touches the same file.
// A key in two areas must translate the same; the catalog test rejects conflicts.
export const ZH_HANS_AREAS: Readonly<Record<string, Catalog>> = {
  appearance,
  chat,
  clientErrors,
  commandPalette,
  common,
  connection,
  contextMeter, // fork: context meter
  desktop,
  devices, // fork: self-hosted devices
  footer,
  loopbackGateway, // fork: remote loopback forwarding
  mcpConnect, // fork: MCP connect and linking
  mobile,
  mobileBrowser,
  mobilePullRequests,
  mobilePush,
  mobileSettings,
  mobileWorkspace,
  outputs, // fork: outputs
  pullRequest,
  settings,
  settingsPanels,
  sharing,
  sidebar,
  storageCleanup,
  t3Tools,
  themeStudio, // fork: theme studio
  time,
  voice, // fork: voice input
  workspace,
};

const catalog: Catalog = Object.assign({}, ...Object.values(ZH_HANS_AREAS));
export default catalog;
