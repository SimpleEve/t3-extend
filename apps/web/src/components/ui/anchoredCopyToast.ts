import type { RefObject } from "react";
import { anchoredToastManager } from "./toast";
import { getUiLocale, translate } from "@t3tools/client-runtime/i18n";

export const ANCHORED_COPY_TOAST_TIMEOUT_MS = 1000;

export function showAnchoredCopySuccessToast(ref: RefObject<HTMLButtonElement | null>) {
  if (!ref.current) return;
  anchoredToastManager.add({
    data: {
      tooltipStyle: true,
    },
    positionerProps: {
      anchor: ref.current,
    },
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
    title: translate(getUiLocale(), "Copied!"),
  });
}

export function showAnchoredCopyErrorToast(ref: RefObject<HTMLButtonElement | null>, error: Error) {
  if (!ref.current) return;
  anchoredToastManager.add({
    type: "error",
    positionerProps: {
      anchor: ref.current,
    },
    title: translate(getUiLocale(), "Failed to copy"),
    description: error.message,
  });
}
