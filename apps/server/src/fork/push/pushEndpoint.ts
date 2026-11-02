import { isPublicAddress, literalIp, systemLocalAddresses } from "./pushAddress.ts";

// fork: the push endpoint is chosen by a paired device, and this server will POST to it.

export const ALLOW_INSECURE_PUSH_ENDPOINTS_ENV = "T3CODE_PUSH_ALLOW_INSECURE_ENDPOINTS";

export interface ValidatedPushEndpoint {
  readonly url: string;
  /** Host and non-default port only; safe to show and to log. */
  readonly host: string;
}

/**
 * Endpoints must be https and, when they spell out an IP address, a public one. Names are
 * resolved when connecting, and `pushTransport.ts` refuses any that lead to a non-public address,
 * so a name is not judged here. `allowInsecure` is for local development and tests only.
 */
export function validatePushEndpoint(
  endpoint: string,
  options: {
    readonly allowInsecure: boolean;
    readonly localAddresses?: () => ReadonlyArray<string>;
  },
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
  if (!options.allowInsecure) {
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost")) return null;
    const ip = literalIp(host);
    const local = (options.localAddresses ?? systemLocalAddresses)();
    if (ip !== null && !isPublicAddress(ip, { localAddresses: local })) return null;
  }
  return { url: url.toString(), host: url.host };
}
