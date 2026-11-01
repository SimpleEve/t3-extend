import { SheetHeader } from "../../components/ui/SheetHeader";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import * as Dialog from "../../components/ui/Dialog";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { EnvironmentId, ThreadId, type PreviewSessionSnapshot } from "@t3tools/contracts";
import { normalizePreviewUrl, previewPdfAssetUrl } from "@t3tools/shared/preview";
import * as Option from "effect/Option";
import { useEffect, useRef, useState } from "react";
import { Platform, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ControlPill } from "../../components/ui/ControlPill";
import { useAppForeground } from "../../lib/appState";
import { AppBar } from "../../components/ui/AppBar";

import { useHardwareBack } from "../../lib/backHandler";
import { useT } from "../../hooks/useT";
import { useCanOpenBrowserTab, useThreadServerBrowserTabs } from "../../state/preview";
import { usePreparedConnection } from "../../state/session";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { BrowserTabMenu } from "./BrowserTabMenu";
import { browserTabTitle, browserTabUrl, latestBrowserTab } from "./browserTabs";
import { NewBrowserTabPanel } from "./NewBrowserTabPanel";
import {
  PreviewStreamWebView,
  type PreviewPictureInPictureState,
  type PreviewStreamRef,
} from "./PreviewStreamWebView";

const BrowserPreviewStack = createNativeStackNavigator<{ BrowserPreview: undefined }>();

const NO_PICTURE_IN_PICTURE: PreviewPictureInPictureState = { supported: false, active: false };

type BrowserPreviewRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly tabId?: string;
  /** Opens the new tab panel first, even when the thread already has tabs. */
  readonly newTab?: string;
}>;

export function BrowserPreviewRouteScreen({ route }: BrowserPreviewRouteScreenProps) {
  const navigation = useNavigation();
  const onClose = () => navigation.goBack();
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <BrowserPreviewStack.Navigator
        screenOptions={{
          headerShown: Platform.OS === "ios",
          headerBackVisible: false,
          headerShadowVisible: false,
          headerTransparent: false,
          headerTitleStyle: { fontSize: 17, fontWeight: "600" },
        }}
      >
        <BrowserPreviewStack.Screen name="BrowserPreview">
          {() => (
            <BrowserPreviewScreen
              environmentId={EnvironmentId.make(route.params.environmentId)}
              threadId={ThreadId.make(route.params.threadId)}
              initialTabId={route.params.tabId ?? null}
              startWithNewTab={route.params.newTab !== undefined}
              onClose={onClose}
            />
          )}
        </BrowserPreviewStack.Screen>
      </BrowserPreviewStack.Navigator>
    </View>
  );
}

function BrowserPreviewScreen({
  environmentId,
  threadId,
  initialTabId,
  startWithNewTab,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly initialTabId: string | null;
  readonly startWithNewTab: boolean;
  readonly onClose: () => void;
}) {
  const t = useT();
  const insets = useSafeAreaInsets();
  const { themeVariables } = useAppearancePreferences();
  const prepared = usePreparedConnection(environmentId);
  const httpBaseUrl = Option.isSome(prepared) ? prepared.value.httpBaseUrl : null;
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const [selectedTabId, setSelectedTabId] = useState(initialTabId);
  const [pictureInPicture, setPictureInPicture] = useState(NO_PICTURE_IN_PICTURE);
  const [streaming, setStreaming] = useState(false);
  const [canControl, setCanControl] = useState(false);
  const streamRef = useRef<PreviewStreamRef>(null);
  const { tabs, loaded } = useThreadServerBrowserTabs({ environmentId, threadId, enabled: true });
  const canOpenTab = useCanOpenBrowserTab(environmentId);
  const [composing, setComposing] = useState(startWithNewTab);
  // The tab `preview.open` returned, until its event lands in the tab list.
  const [pendingTabId, setPendingTabId] = useState<string | null>(null);
  if (pendingTabId !== null && tabs.some((entry) => entry.tabId === pendingTabId)) {
    setPendingTabId(null);
  }
  const tab =
    tabs.find((entry) => entry.tabId === selectedTabId) ??
    (pendingTabId === null ? latestBrowserTab(tabs) : null);
  const pdfUri =
    tab?.navStatus._tag === "Success" ? previewPdfAssetUrl(tab.navStatus.url, httpBaseUrl) : null;
  const tabId = tab?.tabId ?? null;
  if (tabId !== null && tabId !== selectedTabId && pendingTabId === null) {
    setPictureInPicture(NO_PICTURE_IN_PICTURE);
    setSelectedTabId(tabId);
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the focused route through the navigator once the thread has no browser tabs left
  useEffect(() => {
    if (focused && loaded && tabs.length === 0 && !composing && pendingTabId === null) onClose();
  }, [focused, loaded, tabs.length, composing, pendingTabId, onClose]);
  // Back leaves the panel for the open tabs; with none open it closes the browser.
  useHardwareBack(composing && tabs.length > 0, () => {
    setComposing(false);
    return true;
  });
  const onTabOpened = (next: string) => {
    setPictureInPicture(NO_PICTURE_IN_PICTURE);
    setPendingTabId(next);
    setSelectedTabId(next);
    setComposing(false);
  };
  const onPictureInPicture = (state: PreviewPictureInPictureState, detail?: string) => {
    setPictureInPicture({ supported: state.supported, active: state.active });
    if (detail) Dialog.alert(t("Picture in picture is unavailable"), detail);
  };
  const selectTab = (next: string) => {
    setPictureInPicture(NO_PICTURE_IN_PICTURE);
    setSelectedTabId(next);
    setComposing(false);
  };
  const live = (focused && foreground) || pictureInPicture.active;
  const title = composing ? t("New tab") : tab ? browserTabTitle(tab) : t("Browser");
  const onBack = composing && tabs.length > 0 ? () => setComposing(false) : onClose;
  const newTabAction = {
    accessibilityLabel: t("New tab"),
    icon: "plus" as const,
    selected: composing,
    onPress: () => setComposing(true),
  };

  return (
    <View className="flex-1 bg-sheet" style={{ paddingBottom: insets.bottom }}>
      <AppBar
        title={title}
        sidebar={false}
        onBack={onBack}
        options={{ headerBackVisible: false }}
        actions={
          // Android WebView cannot play video in picture in picture.
          Platform.OS === "ios" &&
          !composing &&
          pictureInPicture.supported &&
          (pictureInPicture.active || pdfUri === null)
            ? [
                newTabAction,
                {
                  accessibilityLabel: pictureInPicture.active
                    ? t("Exit picture in picture")
                    : t("Picture in picture"),
                  icon: {
                    ios: pictureInPicture.active ? "pip.exit" : "pip.enter",
                    android: "visibility",
                  },
                  selected: pictureInPicture.active,
                  onPress: () => streamRef.current?.togglePictureInPicture(),
                },
              ]
            : [newTabAction]
        }
        menus={
          tabs.length > 1
            ? [
                {
                  title: t("Tabs"),
                  icon: "square.on.square",
                  items: tabs.map((entry) => ({
                    id: entry.tabId,
                    title: browserTabTitle(entry),
                    subtitle: browserTabUrl(entry),
                    selected: entry.tabId === tabId,
                    onPress: () => selectTab(entry.tabId),
                  })),
                },
              ]
            : []
        }
      />
      {Platform.OS === "ios" ? (
        <SheetHeader title={title} onClose={onClose} accessibilityLabel={t("Close browser")} />
      ) : null}
      {composing ? (
        <NewBrowserTabPanel
          environmentId={environmentId}
          threadId={threadId}
          canOpen={canOpenTab}
          onOpened={onTabOpened}
        />
      ) : tab ? (
        <>
          <BrowserAddressBar
            key={`address:${tab.tabId}`}
            environmentId={environmentId}
            tab={tab}
            streaming={streaming}
            ready={streaming && canControl}
            onCommand={(input) => streamRef.current?.command(input)}
            onPaste={() => streamRef.current?.paste()}
          />
          {live ? (
            <PreviewStreamWebView
              key={`stream:${tab.tabId}`}
              environmentId={environmentId}
              threadId={threadId}
              tabId={tab.tabId}
              pdfUri={pdfUri}
              ref={streamRef}
              interactive
              background={themeVariables["--color-sheet-solid"]}
              onPictureInPicture={onPictureInPicture}
              onStreamingChange={setStreaming}
              onControl={(control) => setCanControl(control?.controller === "you")}
            />
          ) : (
            <View className="flex-1" />
          )}
        </>
      ) : (
        <View className="flex-1 items-center justify-center">
          {focused && foreground ? (
            <AppActivityIndicator color={themeVariables["--color-icon"]} />
          ) : null}
        </View>
      )}
    </View>
  );
}

function BrowserAddressBar({
  environmentId,
  tab,
  ready,
  streaming,
  onCommand,
  onPaste,
}: {
  readonly environmentId: EnvironmentId;
  readonly tab: PreviewSessionSnapshot;
  readonly ready: boolean;
  readonly streaming: boolean;
  readonly onCommand: PreviewStreamRef["command"];
  readonly onPaste: () => void;
}) {
  const url = browserTabUrl(tab);
  const [draft, setDraft] = useState<string | null>(null);
  const submit = () => {
    const value = draft ?? url;
    setDraft(null);
    try {
      onCommand({ type: "navigate", url: normalizePreviewUrl(value) });
    } catch {
      Dialog.alert("Could not open this address", "Enter an http or https URL.");
    }
  };
  return (
    <View className="flex-row items-center gap-1 px-2 pb-2">
      <ControlPill
        icon="chevron.left"
        accessibilityLabel="Back"
        disabled={!ready || !tab.canGoBack}
        onPress={() => onCommand({ type: "history", delta: -1 })}
      />
      <ControlPill
        icon="chevron.right"
        accessibilityLabel="Forward"
        disabled={!ready || !tab.canGoForward}
        onPress={() => onCommand({ type: "history", delta: 1 })}
      />
      <TextInput
        accessibilityLabel="Address"
        editable={ready}
        value={draft ?? url}
        onChangeText={setDraft}
        onBlur={() => setDraft(null)}
        onSubmitEditing={submit}
        placeholder="Enter a URL"
        placeholderTextColorClassName="accent-placeholder"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="go"
        selectTextOnFocus
        lineBreakModeIOS="tail"
        className="h-10 min-w-0 flex-1 rounded-full border border-input-border bg-input px-4 font-sans text-sm text-foreground"
      />
      <ControlPill
        icon="arrow.clockwise"
        accessibilityLabel="Reload page"
        disabled={!ready}
        onPress={() => onCommand({ type: "reload" })}
      />
      <BrowserTabMenu
        environmentId={environmentId}
        tab={tab}
        streaming={streaming}
        onPaste={ready ? onPaste : undefined}
      />
    </View>
  );
}
