// fork: what the gateway manager has worked out, for the code that cannot ask the atoms itself (the
// URL resolver runs in event handlers) and for the pieces that must agree on one answer. Light on
// purpose: the resolver imports it, and nothing here may pull in the connection stack.
import { displayUrlForUnspecified } from "@t3tools/shared/forkLoopbackGateway/hosts";
import type { LoopbackGatewayErrorCode } from "@t3tools/shared/forkLoopbackGateway/protocol";
import { create } from "zustand";

import type { LoopbackGatewayState } from "./gatewayState";

/** `stopped`: registered with forwarding off (the user's switch), so no proxy is installed. */
export type GatewayRegistration = "pending" | "registered" | "stopped" | "failed";

export interface GatewayDenial {
  readonly code: LoopbackGatewayErrorCode;
  readonly port: number;
  /** Position in the order events and tab loads were seen; later means newer. */
  readonly seq: number;
  /**
   * Came before the tab reported this load: no tab was bound to the webview yet, or the bound tab
   * still read as not loading (the preview manager says Idle until a first URL commits, which is
   * after the response headers the refusal is sent from). The next load start is this load.
   */
  readonly early?: boolean;
}

interface TabLoad {
  readonly webContentsId: number | null;
  /** `seq` when the tab last began loading; a denial older than this belongs to an earlier load. */
  readonly loadStartedSeq: number;
  readonly loading: boolean;
}

interface GatewayStoreState {
  readonly states: Readonly<Record<string, LoopbackGatewayState["state"]>>;
  readonly registration: Readonly<Record<string, GatewayRegistration>>;
  /** Counts the user's asks to register an environment again after it failed. */
  readonly retryRequests: Readonly<Record<string, number>>;
  /** Counts tickets handed to the main process, so a card waiting on one can try again. */
  readonly ticketGeneration: Readonly<Record<string, number>>;
  readonly seq: number;
  readonly tabs: Readonly<Record<string, TabLoad>>;
  readonly pageDenials: Readonly<Record<number, GatewayDenial>>;
  readonly connectDenials: Readonly<Record<string, GatewayDenial>>;
}

export const useGatewayStore = create<GatewayStoreState>(() => ({
  states: {},
  registration: {},
  retryRequests: {},
  ticketGeneration: {},
  seq: 0,
  tabs: {},
  pageDenials: {},
  connectDenials: {},
}));

const patch = (update: (state: GatewayStoreState) => Partial<GatewayStoreState>) =>
  useGatewayStore.setState(update);

const without = <T>(record: Readonly<Record<string, T>>, key: string) => {
  if (!(key in record)) return record;
  const { [key]: _removed, ...rest } = record;
  return rest;
};

export function publishGatewayState(environmentId: string, state: LoopbackGatewayState["state"]) {
  if (useGatewayStore.getState().states[environmentId] === state) return;
  patch((store) => ({ states: { ...store.states, [environmentId]: state } }));
}

export function forgetGatewayEnvironment(environmentId: string) {
  patch((store) => ({
    states: without(store.states, environmentId),
    registration: without(store.registration, environmentId),
    retryRequests: without(store.retryRequests, environmentId),
    ticketGeneration: without(store.ticketGeneration, environmentId),
  }));
}

export function setGatewayRegistration(environmentId: string, value: GatewayRegistration | null) {
  patch((store) => ({
    registration:
      value === null
        ? without(store.registration, environmentId)
        : { ...store.registration, [environmentId]: value },
  }));
}

export function requestGatewayRetry(environmentId: string) {
  patch((store) => ({
    retryRequests: {
      ...store.retryRequests,
      [environmentId]: (store.retryRequests[environmentId] ?? 0) + 1,
    },
  }));
}

export function noteGatewayTicketDelivered(environmentId: string) {
  patch((store) => ({
    ticketGeneration: {
      ...store.ticketGeneration,
      [environmentId]: (store.ticketGeneration[environmentId] ?? 0) + 1,
    },
  }));
}

/** The state the resolver and other non-React code read; `undefined` before the manager has run. */
function getLoopbackGatewayState(environmentId: string): LoopbackGatewayState["state"] {
  return useGatewayStore.getState().states[environmentId] ?? "not-applicable";
}

/**
 * `url` as a tab should open it when the environment's localhost is forwarded, or `null` when it is
 * not (and for the system browser, which never goes through the forwarding). `0.0.0.0` becomes
 * `localhost`: a page that spells it that way is not forwarded, but a server that printed it is.
 */
export function forwardedLoopbackUrl(
  environmentId: string,
  url: string,
  systemBrowser: boolean | undefined,
): string | null {
  return systemBrowser !== true && getLoopbackGatewayState(environmentId) === "active"
    ? displayUrlForUnspecified(url)
    : null;
}

/** One call per preview tab state change; a navigation that starts is what retires old denials. */
export function noteGatewayTabState(input: {
  readonly runtimeTabId: string;
  readonly webContentsId: number | null;
  readonly loading: boolean;
}) {
  const { runtimeTabId, webContentsId, loading } = input;
  const previous = useGatewayStore.getState().tabs[runtimeTabId];
  if (previous?.webContentsId === webContentsId && previous.loading === loading) return;
  patch((store) => {
    const startsLoading = loading && previous?.loading !== true;
    const seq = startsLoading ? store.seq + 1 : store.seq;
    // A refusal that came before this load was reported belongs to it and must not read as an
    // earlier one. It counts this way once.
    const early = webContentsId === null ? undefined : store.pageDenials[webContentsId];
    const adopt = early?.early === true;
    const loadStartedSeq = !startsLoading
      ? (previous?.loadStartedSeq ?? 0)
      : adopt
        ? early.seq - 1
        : seq;
    return {
      seq,
      tabs: { ...store.tabs, [runtimeTabId]: { webContentsId, loading, loadStartedSeq } },
      ...(adopt
        ? { pageDenials: { ...store.pageDenials, [webContentsId!]: { ...early, early: false } } }
        : {}),
    };
  });
}

export function noteGatewayDenied(input: {
  readonly environmentId: string;
  readonly code: LoopbackGatewayErrorCode;
  readonly port: number;
  readonly webContentsId: number | undefined;
}) {
  patch((store) => {
    const seq = store.seq + 1;
    const bound = Object.values(store.tabs).find(
      (tab) => tab.webContentsId === input.webContentsId,
    );
    const early = input.webContentsId !== undefined && (bound === undefined || !bound.loading);
    const denial: GatewayDenial = { code: input.code, port: input.port, seq, early };
    return input.webContentsId === undefined
      ? {
          seq,
          connectDenials: {
            ...store.connectDenials,
            [`${input.environmentId}:${input.port}`]: denial,
          },
        }
      : { seq, pageDenials: { ...store.pageDenials, [input.webContentsId]: denial } };
  });
}

/**
 * The refusal behind what this tab shows now, if any: the page the proxy answered for this tab's
 * latest load, or, when that load failed, a refused `CONNECT` (https, ws) for that port since it
 * began. A `CONNECT` has no tab to name, so it only explains a failure and never covers a page that
 * loaded: another tab's refusal, or a hot-reload socket of this one, must not hide a working page.
 */
export function selectGatewayDenial(
  store: GatewayStoreState,
  input: {
    readonly runtimeTabId: string;
    readonly environmentId: string;
    readonly port: number | null;
    readonly loadFailed: boolean;
  },
): GatewayDenial | null {
  const tab = store.tabs[input.runtimeTabId];
  if (tab === undefined) return null;
  const page = tab.webContentsId === null ? undefined : store.pageDenials[tab.webContentsId];
  if (page !== undefined && page.seq > tab.loadStartedSeq) return page;
  if (input.port === null || !input.loadFailed) return null;
  const connect = store.connectDenials[`${input.environmentId}:${input.port}`];
  return connect !== undefined && connect.seq > tab.loadStartedSeq ? connect : null;
}
