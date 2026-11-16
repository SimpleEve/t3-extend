import {
  t3ConnectTroubleshootingUrl,
  type T3ConnectTroubleshootingSection,
} from "@t3tools/contracts";
import type { RelayEnvironmentStatusResponse } from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";

import { interpolate } from "../i18n/translate.ts";
import type { Translator } from "../i18n/store.ts";

import type {
  ConnectionAttemptError,
  ConnectionFailureCause,
  ConnectionHop,
  SupervisorConnectionState,
} from "./model.ts";

export type ConnectionHopResult = "ok" | "failed" | "unchecked";

export interface ConnectionDiagnosisHop {
  readonly hop: ConnectionHop;
  readonly label: string;
  readonly result: ConnectionHopResult;
}

export interface ConnectionDiagnosis {
  /** Names the part that failed, e.g. "Mac mini's tunnel is offline". */
  readonly headline: string;
  readonly hops: ReadonlyArray<ConnectionDiagnosisHop>;
  readonly steps: ReadonlyArray<string>;
  readonly facts: ReadonlyArray<readonly [label: string, value: string]>;
  /** The troubleshooting guide section for this failure. Null for direct routes, except a pending T3 Connect sign-in. */
  readonly moreInfoUrl: string | null;
}

export interface ConnectionDiagnosisInput {
  readonly hostLabel: string;
  readonly state: SupervisorConnectionState;
  /** The environment's usual route, used when the failure does not name one. */
  readonly via: "relay" | "direct";
  /** The relay's last health check, which can name a cause before any connect attempt. */
  readonly relayStatus?: Pick<
    RelayEnvironmentStatusResponse,
    "status" | "endpointFailure" | "endpointStatus" | "offlineReason"
  > | null;
  readonly clientVersion?: string | undefined;
  readonly serverVersion?: string | null | undefined;
  // fork: translates the headline, hops, and steps. Facts stay English for bug reports.
  readonly t?: Translator | undefined;
}

const untranslated: Translator = (source, params) => interpolate(source, params);

interface Located {
  readonly hop: ConnectionHop;
  readonly cause:
    | ConnectionFailureCause
    | "offline"
    | "outdated"
    | "released"
    | "session_pending"
    | null;
  /** The failure named no hop, so the hops before this one were never probed. */
  readonly guessed?: true;
}

const NOT_ANSWERING: ReadonlySet<ConnectionFailureCause> = new Set([
  "origin_unreachable",
  "invalid_response",
]);

function locate(input: ConnectionDiagnosisInput): Located | null {
  const failure = input.state.lastFailure;
  if (input.state.network === "offline" || input.state.phase === "offline") {
    return { hop: "device", cause: "offline" };
  }
  if (failure?._tag === "ConnectionBlockedError" && failure.serverUpdateRequired) {
    return { hop: "server", cause: "outdated" };
  }
  if (failure?.reason === "session-pending") {
    return { hop: "device", cause: "session_pending" };
  }
  if (failure?.hop !== undefined) {
    return { hop: failure.hop, cause: failure.failureCause ?? null };
  }
  if (failure !== null) {
    const unreachable =
      failure.reason === "network" ||
      failure.reason === "timeout" ||
      failure.reason === "transport";
    const via = failure.via ?? input.via;
    return {
      hop: unreachable && via === "relay" ? "tunnel" : "server",
      cause: null,
      guessed: true,
    };
  }
  const status = input.relayStatus;
  if (status?.status !== "offline") return null;
  if (status.offlineReason === "tunnel_released") return { hop: "tunnel", cause: "released" };
  const cause = status.endpointFailure ?? null;
  return { hop: cause !== null && NOT_ANSWERING.has(cause) ? "server" : "tunnel", cause };
}

function headline(
  t: Translator,
  host: string,
  located: Located,
  failure: ConnectionAttemptError | null,
): string {
  switch (located.cause) {
    case "offline":
      return t("This device is offline");
    case "session_pending":
      return t("This device is still loading its T3 Connect sign-in");
    case "approval_pending":
      return t("{host} is waiting for someone to approve this device", { host });
    case "outdated":
      return t("{host} runs an older T3 Extend", { host });
    case "clock_skew":
      return t("This device's clock is off");
    case "not_linked":
      return t("{host} is not linked to your T3 Connect account", { host });
    case "relay_error":
      return t("T3 Connect returned an error");
    case "tunnel_pending":
      return t("{host}'s tunnel is still being set up", { host });
    case "tunnel_not_enabled":
      return t("T3 Connect is not turned on for {host}", { host });
    // fork: a wait, not a failure.
    case "device_list_pending":
      return t("Waiting for your server's device list");
    case "released":
    case "tunnel_down":
      return t("{host}'s tunnel is offline", { host });
    case "origin_unreachable":
      return t("Tunnel works, but T3 Extend on {host} did not answer", { host });
    case "invalid_response":
      return t("T3 Extend on {host} sent an unexpected answer", { host });
    case "dns":
      return t("{host}'s tunnel address did not resolve", { host });
    case "tls":
      return t("Secure connection to {host}'s tunnel failed", { host });
    case "refused":
      return t("{host}'s tunnel refused the connection", { host });
    case "timeout":
      return t("{host} did not answer in time", { host });
    case "unknown":
    case null:
      break;
  }
  switch (located.hop) {
    case "device":
      return t("This device could not prepare the connection");
    case "relay":
      return failure?.reason === "authentication"
        ? t("T3 Connect did not accept this device's sign-in")
        : t("This device can't reach T3 Connect");
    case "tunnel":
      // The relay already reached the host when this device fails on its own.
      return failure?.reason === "network" ||
        failure?.reason === "transport" ||
        failure?.reason === "timeout"
        ? t("This device can't reach {host}'s tunnel", { host })
        : t("T3 Connect could not reach {host}'s tunnel", { host });
    case "server":
      return failure?.reason === "authentication" || failure?.reason === "permission"
        ? t("T3 Extend on {host} did not accept this device", { host })
        : t("T3 Extend on {host} did not answer", { host });
  }
}

function steps(
  t: Translator,
  host: string,
  located: Located,
  failure: ConnectionAttemptError | null,
): string[] {
  // fork: the host may run the official `t3` or this fork's `t3x`, so no command is named.
  const checkHost = t(
    "On {host}, check Settings > Sharing & access or run the `connect status` command.",
    { host },
  );
  switch (located.cause) {
    case "offline":
      return [t("Connect this device to the internet. T3 Extend reconnects on its own.")];
    case "session_pending":
      return [
        t("Wait a moment. T3 Extend retries on its own."),
        t("If it keeps waiting, reload or restart T3 Extend on this device."),
      ];
    case "approval_pending": {
      const code =
        failure?._tag === "ConnectionTransientError" ? failure.verificationCode : undefined;
      const approve = code
        ? t("approve the device showing {code}", { code })
        : t("approve this device");
      return [
        t(
          "On a device already connected to {host}, open Settings > Sharing & access and {approve}.",
          {
            host,
            approve,
          },
        ),
        // fork: the host may run the official `t3` or this fork's `t3x`, so no command is named.
        t("Or run the `auth connect-device approve {code}` command on {host}.", {
          code: code ?? "<code>",
          host,
        }),
      ];
    }
    case "outdated":
      return [t("Update T3 Extend on {host}.", { host })];
    case "clock_skew":
      return [
        t("Turn on automatic date and time on this device and on {host}, then retry.", { host }),
      ];
    case "not_linked":
      return [
        t("Check that this device is signed in to the same T3 Connect account as the host."),
        t("On {host}, open Settings > Sharing & access and turn T3 Connect on.", { host }),
      ];
    case "tunnel_pending":
      return [t("Wait a minute. T3 Extend retries on its own."), checkHost];
    case "relay_error":
      return [
        t("Wait a few minutes. T3 Extend retries on its own."),
        t("If it keeps failing, copy the diagnostics and report it."),
      ];
    case "tunnel_not_enabled":
      return [t("On {host}, open Settings > Sharing & access and turn T3 Connect on.", { host })];
    case "device_list_pending":
      return [t("Wait a moment. T3 Extend retries on its own.")];
    case "released":
    case "tunnel_down":
      return [
        t("Make sure {host} is awake and T3 Extend is running on it.", { host }),
        checkHost,
        t(
          "A VPN or Tailscale exit node on {host} can block the tunnel (port 7844). Turn it off or allow the tunnel.",
          { host },
        ),
      ];
    case "origin_unreachable":
    case "invalid_response":
      return [t("Open or restart T3 Extend on {host}.", { host }), checkHost];
    // The relay saw these on its way to the host, so the fix is on the host.
    case "dns":
    case "tls":
    case "refused":
    case "timeout":
    case "unknown":
      return [t("Make sure {host} is awake and online.", { host }), checkHost];
    case null:
      break;
  }
  switch (located.hop) {
    case "device":
      return [
        t("Restart T3 Extend on this device."),
        t("If it keeps failing, remove {host} from this device and add it again.", { host }),
      ];
    case "relay":
      return failure?.reason === "authentication"
        ? [t("Sign out of T3 Connect and sign in again.")]
        : [
            t("Check this device's internet connection."),
            t("A VPN, firewall, or ad blocker on this device can block T3 Connect."),
          ];
    case "tunnel":
      return failure?.reason === "network" ||
        failure?.reason === "transport" ||
        failure?.reason === "timeout"
        ? [
            t("A VPN, firewall, or DNS filter on this device can block the tunnel."),
            t("Try another network, or add a direct route such as a Tailscale address."),
          ]
        : [t("Make sure {host} is awake and online.", { host }), checkHost];
    case "server":
      return [
        t("Make sure T3 Extend is running on {host}.", { host }),
        t("Retry. If it keeps failing, copy the diagnostics."),
      ];
  }
}

function helpSection(
  located: Located,
  failure: ConnectionAttemptError | null,
): T3ConnectTroubleshootingSection | null {
  switch (located.cause) {
    case "offline":
      return "this-device-cant-reach-t3-connect";
    case "outdated":
      return "the-host-runs-an-older-t3-code";
    case "clock_skew":
      return "the-clock-is-off";
    case "session_pending":
    case "approval_pending":
    case "not_linked":
    case "tunnel_not_enabled":
      return "sign-in-account-or-link-problems";
    // fork: your own server's device list has nothing to do with T3 Connect, so no guide link.
    case "device_list_pending":
      return null;
    case "relay_error":
      return "t3-connect-returned-an-error";
    case "released":
    case "tunnel_down":
    case "tunnel_pending":
      return "the-hosts-tunnel-is-offline";
    case "origin_unreachable":
    case "invalid_response":
      return "the-tunnel-works-but-t3-code-does-not-answer";
    case "dns":
    case "tls":
    case "refused":
    case "timeout":
    case "unknown":
      return "the-t3-connect-address-does-not-resolve-or-answer";
    case null:
      break;
  }
  const onThisDevice =
    failure?.reason === "network" ||
    failure?.reason === "transport" ||
    failure?.reason === "timeout";
  switch (located.hop) {
    case "device":
      return "this-device-cant-reach-t3-connect";
    case "relay":
      return failure?.reason === "authentication"
        ? "sign-in-account-or-link-problems"
        : "this-device-cant-reach-t3-connect";
    case "tunnel":
      return onThisDevice ? "this-device-cant-reach-t3-connect" : "the-hosts-tunnel-is-offline";
    case "server":
      return failure?.reason === "authentication" || failure?.reason === "permission"
        ? "sign-in-account-or-link-problems"
        : "the-tunnel-works-but-t3-code-does-not-answer";
  }
}

const HOP_ORDER = {
  relay: ["device", "relay", "tunnel", "server"],
  direct: ["device", "server"],
} as const;

function hopLabel(t: Translator, hop: ConnectionHop, host: string): string {
  switch (hop) {
    case "device":
      return t("This device");
    case "relay":
      return "T3 Connect";
    case "tunnel":
      return t("{host} tunnel", { host });
    case "server":
      return t("T3 Extend on {host}", { host });
  }
}

function helpUrl(
  located: Located,
  failure: ConnectionAttemptError | null,
  relayPath: boolean,
): string | null {
  if (!relayPath && located.cause !== "session_pending") return null;
  const section = helpSection(located, failure);
  return section === null ? null : t3ConnectTroubleshootingUrl(section);
}

/**
 * Turns a connection state into what failed, in order, and what to try. Returns
 * null when nothing has failed. Web and mobile render this same model.
 */
export function presentConnectionDiagnosis(
  input: ConnectionDiagnosisInput,
): ConnectionDiagnosis | null {
  const located = locate(input);
  if (located === null) return null;
  const host = input.hostLabel;
  const t = input.t ?? untranslated;
  const failure = input.state.lastFailure;
  const relayPath =
    located.hop === "relay" ||
    located.hop === "tunnel" ||
    (failure === null && input.relayStatus?.status === "offline") ||
    (failure?.via ?? input.via) === "relay";
  const order: ReadonlyArray<ConnectionHop> = HOP_ORDER[relayPath ? "relay" : "direct"];
  const failedIndex = order.indexOf(located.hop);
  const hops = order.map((hop, index): ConnectionDiagnosisHop => ({
    hop,
    label: hopLabel(t, hop, host),
    result:
      index === failedIndex
        ? "failed"
        : index < failedIndex && located.guessed !== true
          ? "ok"
          : "unchecked",
  }));

  // The relay health check only explains the state when no attempt has failed yet.
  const httpStatus = failure !== null ? failure.httpStatus : input.relayStatus?.endpointStatus;
  const facts: Array<readonly [string, string]> = [];
  const add = (label: string, value: string | number | null | undefined) => {
    if (value !== null && value !== undefined && value !== "") facts.push([label, String(value)]);
  };
  add("Cause", located.cause ?? failure?.reason);
  add("HTTP status", httpStatus);
  add("Attempts", input.state.attempt > 0 ? input.state.attempt : null);
  add(
    "Next retry",
    input.state.retryAt === null
      ? null
      : DateTime.formatIso(DateTime.makeUnsafe(input.state.retryAt)),
  );
  add("Route", relayPath ? "T3 Connect" : "Direct");
  add("App version", input.clientVersion);
  add("Host version", input.serverVersion);
  add("Error", failure?.detail);
  add("Trace ID", failure?.traceId);

  return {
    headline: headline(t, host, located, failure),
    hops,
    steps: steps(t, host, located, failure),
    facts,
    moreInfoUrl: helpUrl(located, failure, relayPath),
  };
}

const HOP_MARK = { ok: "ok", failed: "FAILED", unchecked: "not checked" } as const;

/** One plain-text block for bug reports. */
export function connectionDiagnosisText(hostLabel: string, diagnosis: ConnectionDiagnosis): string {
  return [
    `T3 Extend connection to ${hostLabel}: ${diagnosis.headline}`,
    "",
    ...diagnosis.hops.map((hop) => `${hop.label}: ${HOP_MARK[hop.result]}`),
    "",
    ...diagnosis.facts.map(([label, value]) => `${label}: ${value}`),
    ...(diagnosis.moreInfoUrl ? ["", `More info: ${diagnosis.moreInfoUrl}`] : []),
  ].join("\n");
}
