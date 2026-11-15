import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Electron from "electron";
import { getUiLocale, translate, type TranslateParams } from "@t3tools/client-runtime/i18n"; // fork: interface language

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopWindow from "./DesktopWindow.ts";
import * as DesktopUiLanguage from "../settings/DesktopUiLanguage.ts";

export class DesktopApplicationMenuActionError extends Schema.TaggedError<DesktopApplicationMenuActionError>()(
  "DesktopApplicationMenuActionError",
  {
    action: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop menu action "${this.action}" failed.`;
  }
}

export class DesktopApplicationMenu extends Context.Service<
  DesktopApplicationMenu,
  {
    readonly configure: Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/DesktopApplicationMenu") {}

type DesktopApplicationMenuRuntimeServices =
  | DesktopUpdates.DesktopUpdates
  | DesktopWindow.DesktopWindow
  | ElectronDialog.ElectronDialog;

const { logInfo: logUpdaterInfo } = makeComponentLogger("desktop-updater");

const { logError: logMenuError } = makeComponentLogger("desktop-menu");

const dispatchMenuAction = Effect.fn("desktop.menu.dispatchMenuAction")(function* (
  action: string,
): Effect.fn.Return<void, DesktopWindow.DesktopWindowError, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.dispatchMenuAction(action, {
    reveal: action !== "paste-as-text",
  });
});

const zoomMainWindow = Effect.fn("desktop.menu.zoomMainWindow")(function* (
  direction: DesktopWindow.MainWindowZoomDirection,
): Effect.fn.Return<void, never, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.zoomMain(direction);
});

const runMainContentsCommand = Effect.fn("desktop.menu.runMainContentsCommand")(function* (
  command: DesktopWindow.MainWindowContentsCommand,
): Effect.fn.Return<void, never, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.runMainContentsCommand(command);
});

const t = (source: string, params?: TranslateParams) => translate(getUiLocale(), source, params);

const describeUpdate = (version: string | null) =>
  version === null ? t("A new version of T3 Extend") : t("T3 Extend {version}", { version });

const checkForUpdatesFromMenu = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const result = yield* updates.check("menu");
  const updateState = result.state;

  if (updateState.status === "up-to-date") {
    yield* electronDialog.showMessageBox({
      type: "info",
      title: t("You're up to date!"),
      message: t("T3 Extend {version} is currently the newest version available.", {
        version: updateState.currentVersion,
      }),
      buttons: [t("OK")],
    });
  } else if (updateState.status === "available") {
    const { response } = yield* electronDialog.showMessageBox({
      type: "info",
      title: t("Update available"),
      message: t("{update} is available.", {
        update: describeUpdate(updateState.availableVersion),
      }),
      detail: t("You're running T3 Extend {version}.", { version: updateState.currentVersion }),
      buttons: [t("Download"), t("Later")],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) yield* updates.download;
  } else if (updateState.status === "downloading") {
    yield* electronDialog.showMessageBox({
      type: "info",
      title: t("Update downloading"),
      message: t("{update} is already downloading.", {
        update: describeUpdate(updateState.availableVersion),
      }),
      buttons: [t("OK")],
    });
  } else if (updateState.status === "downloaded") {
    const { response } = yield* electronDialog.showMessageBox({
      type: "info",
      title: t("Update ready"),
      message: t("{update} is ready to install.", {
        update: describeUpdate(updateState.downloadedVersion ?? updateState.availableVersion),
      }),
      detail: t("T3 Extend will restart to install it. Any running tasks will be interrupted."),
      buttons: [t("Restart"), t("Later")],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) yield* updates.install;
  } else if (updateState.status === "error") {
    yield* electronDialog.showMessageBox({
      type: "warning",
      title: t("Update check failed"),
      message: t("Could not check for updates."),
      detail: updateState.message ?? t("An unknown error occurred. Please try again later."),
      buttons: [t("OK")],
    });
  }
}).pipe(Effect.withSpan("desktop.menu.checkForUpdates"));

const handleCheckForUpdatesMenuClick = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const disabledReason = yield* updates.disabledReason;
  if (Option.isSome(disabledReason)) {
    yield* logUpdaterInfo("manual update check requested, but updates are disabled", {
      disabledReason: disabledReason.value,
    });
    yield* electronDialog.showMessageBox({
      type: "info",
      title: t("Updates unavailable"),
      message: t("Automatic updates are not available right now."),
      detail: disabledReason.value,
      buttons: [t("OK")],
    });
    return;
  }

  // Opening a window before backend confirmation can strand it on failed auth bootstrap.
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.activate;
  yield* checkForUpdatesFromMenu;
}).pipe(Effect.withSpan("desktop.menu.handleCheckForUpdatesClick"));

/** @public */
export const make = Effect.gen(function* () {
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const uiLanguage = yield* DesktopUiLanguage.DesktopUiLanguage;
  const context = yield* Effect.context<DesktopApplicationMenuRuntimeServices>();
  const runPromise = Effect.runPromiseWith(context);

  const runMenuEffect = <E>(
    action: string,
    effect: Effect.Effect<void, E, DesktopApplicationMenuRuntimeServices>,
  ) => {
    void runPromise(
      effect.pipe(
        Effect.annotateLogs({ action }),
        Effect.withSpan("desktop.menu.action"),
        Effect.catchCause((cause) => {
          const error = new DesktopApplicationMenuActionError({ action, cause });
          return logMenuError(error.message, { error });
        }),
      ),
    );
  };

  const configure = Effect.gen(function* () {
    // fork: build the menu in the interface language; settings changes call configure again.
    const locale = yield* uiLanguage.apply;
    const label = (source: string, params?: TranslateParams) => translate(locale, source, params);
    // Electron names role items in English; label them only when a translation is wanted.
    const role = <R extends NonNullable<Electron.MenuItemConstructorOptions["role"]>>(
      itemRole: R,
      source: string,
    ): Electron.MenuItemConstructorOptions =>
      locale === "en" ? { role: itemRole } : { role: itemRole, label: label(source) };
    const checkForUpdatesClick = () => {
      runMenuEffect("check-for-updates", handleCheckForUpdatesMenuClick);
    };
    const settingsClick = () => {
      runMenuEffect("open-settings", dispatchMenuAction("open-settings"));
    };
    // Chromium and the renderer already handle this chord; injecting another paste duplicates text.
    const pasteAsTextClick = (
      _item: Electron.MenuItem,
      _window: Electron.BaseWindow | undefined,
      event: Electron.KeyboardEvent,
    ) => {
      if (event.triggeredByAccelerator === true) return;
      runMenuEffect("paste-as-text", dispatchMenuAction("paste-as-text"));
    };
    const zoomClick = (direction: DesktopWindow.MainWindowZoomDirection) => () => {
      runMenuEffect(`zoom-${direction}`, zoomMainWindow(direction));
    };
    const mainContentsClick = (command: DesktopWindow.MainWindowContentsCommand) => () => {
      runMenuEffect(command, runMainContentsCommand(command));
    };
    // fork: no "Check for Updates..." when the build has no update feed.
    const checkForUpdatesItems: Electron.MenuItemConstructorOptions[] =
      (yield* updates.hasUpdateFeed)
        ? [{ label: label("Check for Updates..."), click: checkForUpdatesClick }]
        : [];
    const template: Electron.MenuItemConstructorOptions[] = [];

    if (environment.platform === "darwin") {
      template.push({
        label: environment.displayName,
        submenu: [
          { role: "about", label: label("About {name}", { name: environment.displayName }) },
          ...checkForUpdatesItems, // fork: feed-gated
          { type: "separator" },
          {
            label: label("Settings..."),
            accelerator: "CmdOrCtrl+,",
            click: settingsClick,
          },
          { type: "separator" },
          role("services", "Services"),
          { type: "separator" },
          { role: "hide", label: label("Hide {name}", { name: environment.displayName }) },
          role("hideOthers", "Hide Others"),
          role("unhide", "Show All"),
          { type: "separator" },
          { role: "quit", label: label("Quit {name}", { name: environment.displayName }) },
        ],
      });
    }

    template.push(
      {
        label: label("File"),
        submenu: [
          ...(environment.platform === "darwin"
            ? []
            : [
                {
                  label: label("Settings..."),
                  accelerator: "CmdOrCtrl+,",
                  click: settingsClick,
                },
                { type: "separator" as const },
              ]),
          {
            label: label("Close Developer Tools"),
            accelerator: "CmdOrCtrl+W",
            visible: false,
            click: () => {
              Electron.webContents
                .getAllWebContents()
                .find((contents) => !contents.isDestroyed() && contents.isDevToolsFocused())
                ?.closeDevTools();
            },
          },
          // Cmd/Ctrl+W belongs to the renderer's tab close; it must never close the window.
          environment.platform === "darwin"
            ? { label: label("Close Window"), click: (_item, window) => window?.close() }
            : role("quit", "Quit"),
        ],
      },
      {
        label: label("Edit"),
        submenu: [
          role("undo", "Undo"),
          role("redo", "Redo"),
          { type: "separator" },
          role("cut", "Cut"),
          role("copy", "Copy"),
          role("paste", "Paste"),
          {
            label: label("Paste as Text"),
            accelerator: "CmdOrCtrl+Shift+V",
            click: pasteAsTextClick,
          },
          role("delete", "Delete"),
          { type: "separator" },
          role("selectAll", "Select All"),
          ...(environment.platform === "darwin"
            ? [
                { type: "separator" as const },
                {
                  label: label("Speech"),
                  submenu: [
                    role("startSpeaking", "Start Speaking"),
                    role("stopSpeaking", "Stop Speaking"),
                  ],
                },
              ]
            : []),
        ],
      },
      {
        label: label("View"),
        submenu: [
          /* Native reload/DevTools/zoom roles target focused guests; these commands must target the app. */
          {
            label: label("Reload"),
            accelerator: "CmdOrCtrl+R",
            click: mainContentsClick("reload"),
          },
          {
            label: label("Force Reload"),
            accelerator: "Shift+CmdOrCtrl+R",
            click: mainContentsClick("forceReload"),
          },
          {
            label: label("Toggle Developer Tools"),
            accelerator: environment.platform === "darwin" ? "Alt+Command+I" : "Ctrl+Shift+I",
            click: mainContentsClick("toggleDevTools"),
          },
          { type: "separator" },
          { label: label("Actual Size"), accelerator: "CmdOrCtrl+0", click: zoomClick("reset") },
          { label: label("Zoom In"), accelerator: "CmdOrCtrl+=", click: zoomClick("in") },
          {
            label: label("Zoom In"),
            accelerator: "CmdOrCtrl+Plus",
            visible: false,
            click: zoomClick("in"),
          },
          ...(environment.platform === "darwin"
            ? [
                {
                  label: label("Zoom In"),
                  accelerator: "CmdOrCtrl+Shift+=",
                  visible: false,
                  click: zoomClick("in"),
                },
              ]
            : []),
          { label: label("Zoom Out"), accelerator: "CmdOrCtrl+-", click: zoomClick("out") },
          // Keypad codes do not match number-row accelerators.
          {
            label: label("Actual Size"),
            accelerator: "CmdOrCtrl+num0",
            visible: false,
            click: zoomClick("reset"),
          },
          {
            label: label("Zoom In"),
            accelerator: "CmdOrCtrl+numadd",
            visible: false,
            click: zoomClick("in"),
          },
          {
            label: label("Zoom Out"),
            accelerator: "CmdOrCtrl+numsub",
            visible: false,
            click: zoomClick("out"),
          },
          { type: "separator" },
          role("togglefullscreen", "Toggle Full Screen"),
        ],
      },
      {
        // Electron's default Window submenu adds a Ctrl+W close role off macOS.
        ...role("windowMenu", "Window"),
        submenu: [
          role("minimize", "Minimize"),
          role("zoom", "Zoom"),
          ...(environment.platform === "darwin"
            ? [{ type: "separator" as const }, role("front", "Bring All to Front")]
            : []),
        ],
      },
      {
        ...role("help", "Help"),
        submenu: checkForUpdatesItems, // fork: feed-gated
      },
    );

    yield* electronMenu.setApplicationMenu(template);
  }).pipe(Effect.withSpan("desktop.menu.configure"));

  return DesktopApplicationMenu.of({
    configure,
  });
});

export const layer = Layer.effect(DesktopApplicationMenu, make);
