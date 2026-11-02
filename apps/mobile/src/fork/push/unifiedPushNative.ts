import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

import {
  NO_NATIVE_STATE,
  type UnifiedPushNativeState,
  type UnifiedPushSubscription,
} from "./unifiedPushTypes";

export { NO_NATIVE_STATE };
export type {
  UnifiedPushDistributor,
  UnifiedPushNativeState,
  UnifiedPushSubscription,
} from "./unifiedPushTypes";

// fork: Android bridge to the UnifiedPush connector (modules/t3x-unified-push).

interface Subscription {
  remove(): void;
}

interface T3xUnifiedPushModule {
  getState(): UnifiedPushNativeState;
  getSubscription(): UnifiedPushSubscription | null;
  setEnabled(enabled: boolean): void;
  selectDistributor(distributor: string): void;
  register(): void;
  unregister(): void;
  setTemplates(templates: string, scheme: string): void;
  setThreadOnScreen(path: string | null): void;
  addListener(event: "onChange", listener: () => void): Subscription;
}

const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<T3xUnifiedPushModule>("T3xUnifiedPush")
    : null;

/** False on iOS and in builds without the module; nothing here may crash there. */
export function supportsUnifiedPush(): boolean {
  return typeof native?.getState === "function";
}

export function readUnifiedPushState(): UnifiedPushNativeState {
  try {
    return native?.getState() ?? NO_NATIVE_STATE;
  } catch {
    return NO_NATIVE_STATE;
  }
}

export function readUnifiedPushSubscription(): UnifiedPushSubscription | null {
  try {
    return native?.getSubscription() ?? null;
  } catch {
    return null;
  }
}

export function setUnifiedPushEnabled(enabled: boolean): void {
  native?.setEnabled(enabled);
}

export function selectUnifiedPushDistributor(distributor: string): void {
  native?.selectDistributor(distributor);
}

export function registerUnifiedPush(): void {
  native?.register();
}

export function unregisterUnifiedPush(): void {
  native?.unregister();
}

export function setUnifiedPushTemplates(templates: string, scheme: string): void {
  native?.setTemplates(templates, scheme);
}

export function setUnifiedPushThreadOnScreen(path: string | null): void {
  native?.setThreadOnScreen(path);
}

export function onUnifiedPushChange(listener: () => void): () => void {
  const subscription = native?.addListener("onChange", listener);
  return () => subscription?.remove();
}
