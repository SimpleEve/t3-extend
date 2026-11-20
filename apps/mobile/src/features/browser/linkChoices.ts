import {
  isLocalLoopbackHost,
  isWildcardHost,
  normalizeHostname,
} from "@t3tools/shared/hostClassification";

// Read by hand: React Native's URL does not parse every host form reliably.
const WEB_LINK = /^(https?):\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/i;

const webLinkHost = (href: string): string | null => {
  const host = WEB_LINK.exec(href.trim())?.[2];
  return host === undefined || host === "" ? null : normalizeHostname(host);
};

/** A web link whose host names the machine that opens it, which for a phone is the phone. */
export function isLoopbackLink(href: string): boolean {
  const host = webLinkHost(href);
  return (
    host !== null &&
    (isLocalLoopbackHost(host) || host.endsWith(".localhost") || isWildcardHost(host))
  );
}

export type LinkChoice = "built-in" | "system" | "copy";

/** The server's browser takes only web links, and only when this connection can open tabs. */
export function linkChoices(href: string, builtInAvailable: boolean): ReadonlyArray<LinkChoice> {
  return builtInAvailable && webLinkHost(href) !== null
    ? ["built-in", "system", "copy"]
    : ["system", "copy"];
}

/** What a tap does: a loopback link opens where it can be reached, anything else as before. */
export function linkTapChoice(href: string, builtInAvailable: boolean): "built-in" | "system" {
  return isLoopbackLink(href) && linkChoices(href, builtInAvailable).includes("built-in")
    ? "built-in"
    : "system";
}

/** The choices with the tap's first, for a row whose tap runs its first action. */
export function linkChoicesTapFirst(
  href: string,
  builtInAvailable: boolean,
): ReadonlyArray<LinkChoice> {
  const tap = linkTapChoice(href, builtInAvailable);
  return [tap, ...linkChoices(href, builtInAvailable).filter((choice) => choice !== tap)];
}
