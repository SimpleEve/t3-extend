import { getUiLocale, translatorFor } from "@t3tools/client-runtime/i18n"; // fork: i18n

export function resolveAgentAwarenessPlatformPresentation(platform: string): {
  readonly supported: boolean;
  readonly subtitle: string | undefined;
} {
  return platform === "ios" || platform === "android"
    ? { supported: true, subtitle: undefined }
    : { supported: false, subtitle: translatorFor(getUiLocale())("Unavailable on this platform") };
}
