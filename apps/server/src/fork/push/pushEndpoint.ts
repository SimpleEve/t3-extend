// fork: the push endpoint is chosen by a paired device, and this server will POST to it.

export const ALLOW_INSECURE_PUSH_ENDPOINTS_ENV = "T3CODE_PUSH_ALLOW_INSECURE_ENDPOINTS";

export interface ValidatedPushEndpoint {
  readonly url: string;
  /** Host and non-default port only; safe to show and to log. */
  readonly host: string;
}

const isLoopbackOrLinkLocalHost = (hostname: string): boolean => {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host.startsWith("fe80:") ||
    /^127\./.test(host) ||
    /^169\.254\./.test(host) ||
    host === "0.0.0.0"
  );
};

/**
 * Endpoints must be https and must not point at this machine or its link-local
 * metadata address, so a paired device cannot use the server to poke at local
 * services. Private LAN addresses stay allowed for self-hosted push servers.
 * `allowInsecure` is for local development and tests only.
 */
export function validatePushEndpoint(
  endpoint: string,
  options: { readonly allowInsecure: boolean },
): ValidatedPushEndpoint | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "" || url.hostname === "") return null;
  if (url.protocol !== "https:" && !(options.allowInsecure && url.protocol === "http:")) {
    return null;
  }
  if (!options.allowInsecure && isLoopbackOrLinkLocalHost(url.hostname)) return null;
  return { url: url.toString(), host: url.host };
}
