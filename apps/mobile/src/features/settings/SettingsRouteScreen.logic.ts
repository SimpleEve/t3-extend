import type { Translator } from "@t3tools/client-runtime/i18n"; // fork: i18n

export function resolveAgentAwarenessPlatformPresentation(
  platform: string,
  t: Translator, // fork: i18n
): {
  readonly supported: boolean;
  readonly subtitle: string | undefined;
} {
  return platform === "ios" || platform === "android"
    ? { supported: true, subtitle: undefined }
    : { supported: false, subtitle: "Unavailable on this platform" };
}
