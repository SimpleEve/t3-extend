// fork: `window.t3xLoopbackGatewayBridge`, built from the preload's own Electron objects. Kept in
// its own file so the sandboxed preload takes a few lines; it imports channel names and types only.
import type {
  LoopbackGatewayBridge,
  LoopbackGatewayEvent,
} from "@t3tools/shared/forkLoopbackGateway/bridge";

import * as Channels from "./channels.ts";

export const exposeLoopbackGatewayBridge = (
  contextBridge: Pick<Electron.ContextBridge, "exposeInMainWorld">,
  ipcRenderer: Pick<Electron.IpcRenderer, "invoke" | "on" | "removeListener">,
): void => {
  contextBridge.exposeInMainWorld(Channels.LOOPBACK_GATEWAY_BRIDGE_GLOBAL, {
    register: (input) => ipcRenderer.invoke(Channels.LOOPBACK_GATEWAY_REGISTER_CHANNEL, input),
    updateTicket: (input) =>
      ipcRenderer.invoke(Channels.LOOPBACK_GATEWAY_UPDATE_TICKET_CHANNEL, input),
    unregister: (input) => ipcRenderer.invoke(Channels.LOOPBACK_GATEWAY_UNREGISTER_CHANNEL, input),
    setEnabled: (input) => ipcRenderer.invoke(Channels.LOOPBACK_GATEWAY_SET_ENABLED_CHANNEL, input),
    setReachable: (input) =>
      ipcRenderer.invoke(Channels.LOOPBACK_GATEWAY_SET_REACHABLE_CHANNEL, input),
    getStatus: (input) => ipcRenderer.invoke(Channels.LOOPBACK_GATEWAY_GET_STATUS_CHANNEL, input),
    onEvent: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, event: LoopbackGatewayEvent) =>
        listener(event);
      ipcRenderer.on(Channels.LOOPBACK_GATEWAY_EVENT_CHANNEL, wrapped);
      return () => {
        ipcRenderer.removeListener(Channels.LOOPBACK_GATEWAY_EVENT_CHANNEL, wrapped);
      };
    },
  } satisfies LoopbackGatewayBridge);
};
