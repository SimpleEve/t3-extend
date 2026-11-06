// Kept free of imports: the sandboxed preload bundles this file.
export const LOOPBACK_GATEWAY_REGISTER_CHANNEL = "t3x:loopback-gateway:register";
export const LOOPBACK_GATEWAY_UPDATE_TICKET_CHANNEL = "t3x:loopback-gateway:update-ticket";
export const LOOPBACK_GATEWAY_UNREGISTER_CHANNEL = "t3x:loopback-gateway:unregister";
export const LOOPBACK_GATEWAY_SET_ENABLED_CHANNEL = "t3x:loopback-gateway:set-enabled";
export const LOOPBACK_GATEWAY_SET_REACHABLE_CHANNEL = "t3x:loopback-gateway:set-reachable";
export const LOOPBACK_GATEWAY_GET_STATUS_CHANNEL = "t3x:loopback-gateway:get-status";
export const LOOPBACK_GATEWAY_EVENT_CHANNEL = "t3x:loopback-gateway:event";
// Mirrors LOOPBACK_GATEWAY_BRIDGE_GLOBAL in @t3tools/shared/forkLoopbackGateway/bridge, which the preload cannot require.
export const LOOPBACK_GATEWAY_BRIDGE_GLOBAL = "t3xLoopbackGatewayBridge";
