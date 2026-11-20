// oxlint-disable t3code/no-untranslated-copy -- verdict details become Error messages, which keep English where they are made
// fork: what a client may believe about a computer before it sends anything to it (design Q10).
// Order: the registry's list, then the URL check, then the computer's own well-known answer, and
// only then a pass. Everything here is pure; the effects live in liveAuthorization.ts.
import type { ConnectionAttemptError } from "../../connection/model.ts";
import { deviceConnectionBlocked, deviceConnectionTransient } from "./DeviceKeyAuthorization.ts";

/** The registry this client joined. `registryId` is null where a trusted server did the pinning. */
export interface PinnedRegistry {
  readonly origin: string;
  readonly registryId: string | null;
}

export interface DeviceComputer {
  readonly deviceId: string;
  readonly name: string;
  readonly url: string | null;
  /** What the registry recorded for this computer; null until it first reports itself. */
  readonly environmentId: string | null;
  readonly self: boolean;
  readonly online?: boolean;
}

export interface DeviceDirectoryView {
  readonly pin: PinnedRegistry;
  readonly computers: ReadonlyArray<DeviceComputer>;
  /**
   * Whether `computers[].environmentId` is the registry's own record. A desktop reads the list
   * through its local server, which does not pass the record on, so there an id is learned from
   * the computer and the server checks it against the registry when it signs the pass.
   */
  readonly recordsEnvironmentIds: boolean;
}

/** The registry-route URL of a computer, or null when it is not a one-level subdomain of the pin. */
export const checkComputerUrl = (pin: PinnedRegistry, url: string): string | null => {
  let target: URL;
  let registry: URL;
  try {
    target = new URL(url);
    registry = new URL(pin.origin);
  } catch {
    return null;
  }
  if (target.protocol !== "https:" || target.username !== "" || target.password !== "") return null;
  if (target.search !== "" || target.hash !== "" || target.pathname !== "/") return null;
  if (target.port !== registry.port) return null;
  const domain = registry.hostname;
  if (!target.hostname.endsWith(`.${domain}`)) return null;
  const label = target.hostname.slice(0, -(domain.length + 1));
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return null;
  return target.origin;
};

/** True for a host in the registry's domain, whether or not it passes `checkComputerUrl`. */
const isUnderRegistryDomain = (pin: PinnedRegistry, url: string): boolean => {
  try {
    const target = new URL(url);
    const domain = new URL(pin.origin).hostname;
    return target.hostname === domain || target.hostname.endsWith(`.${domain}`);
  } catch {
    return false;
  }
};

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

export type RouteVerdict =
  | { readonly _tag: "ok" }
  | { readonly _tag: "blocked"; readonly detail: string }
  | { readonly _tag: "pending"; readonly detail: string };

/**
 * Whether `routeUrl` may be used for `computer`. The registry's own URL must pass the URL check.
 * A route under the registry's domain that is not that URL is refused. A route elsewhere is one the
 * computer itself advertised (LAN, tailnet) and is only held to the well-known check that follows.
 */
export const judgeRoute = (input: {
  readonly view: DeviceDirectoryView;
  readonly computer: DeviceComputer;
  readonly routeUrl: string;
  readonly expectedEnvironmentId: string;
}): RouteVerdict => {
  const { view, computer, routeUrl, expectedEnvironmentId } = input;
  if (view.recordsEnvironmentIds) {
    if (computer.environmentId === null) {
      return {
        _tag: "pending",
        detail: "That computer has not reported itself to your server yet.",
      };
    }
    if (computer.environmentId !== expectedEnvironmentId) {
      return {
        _tag: "blocked",
        detail: "That computer is not the environment this connection was saved for.",
      };
    }
  }
  const approved = computer.url === null ? null : checkComputerUrl(view.pin, computer.url);
  const listed = computer.url === null ? null : originOf(computer.url);
  // The registry's own address for the computer has to pass the URL check; so does anything else
  // under the registry's domain.
  if (isUnderRegistryDomain(view.pin, routeUrl) || originOf(routeUrl) === listed) {
    if (approved === null || approved !== originOf(routeUrl)) {
      return {
        _tag: "blocked",
        detail: "The address for that computer does not match your server.",
      };
    }
  }
  return { _tag: "ok" };
};

export const verdictError = (
  verdict: Exclude<RouteVerdict, { readonly _tag: "ok" }>,
): ConnectionAttemptError =>
  verdict._tag === "pending"
    ? deviceConnectionTransient(verdict.detail)
    : deviceConnectionBlocked(verdict.detail);
