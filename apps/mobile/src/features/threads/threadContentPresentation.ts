import { type EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { getUiLocale, translatorFor } from "@t3tools/client-runtime/i18n"; // fork: i18n

export type ThreadContentPresentation =
  | { readonly kind: "ready" }
  | { readonly kind: "loading" }
  | {
      readonly kind: "unavailable";
      readonly title: string;
      readonly detail: string;
    };

export function projectThreadContentPresentation(input: {
  readonly hasDetail: boolean;
  readonly detailError: string | null;
  readonly detailDeleted: boolean;
  readonly connectionState: EnvironmentConnectionPhase;
}): ThreadContentPresentation {
  if (input.hasDetail) {
    return { kind: "ready" };
  }
  if (input.detailDeleted) {
    return {
      kind: "unavailable",
      title: translatorFor(getUiLocale())("Thread unavailable"),
      detail: translatorFor(getUiLocale())("This thread was deleted or is no longer available."),
    };
  }
  if (input.detailError !== null) {
    return {
      kind: "unavailable",
      title: translatorFor(getUiLocale())("Could not load conversation"),
      detail: input.detailError,
    };
  }
  if (
    input.connectionState === "connected" ||
    input.connectionState === "connecting" ||
    input.connectionState === "reconnecting"
  ) {
    return { kind: "loading" };
  }
  return {
    kind: "unavailable",
    title: translatorFor(getUiLocale())("Messages not cached"),
    detail: translatorFor(getUiLocale())("Reconnect this environment to load the conversation."),
  };
}
