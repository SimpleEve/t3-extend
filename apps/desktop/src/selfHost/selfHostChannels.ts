// Kept free of imports: the sandboxed preload bundles this file.
export const GET_SELF_HOST_STATE_CHANNEL = "t3x:self-host:get-state";
export const SET_SELF_HOST_PUBLIC_URLS_CHANNEL = "t3x:self-host:set-public-urls";
export const SET_SELF_HOST_TUNNEL_CHANNEL = "t3x:self-host:set-tunnel";
export const RESTART_SELF_HOST_TUNNEL_CHANNEL = "t3x:self-host:restart-tunnel";
export const SELF_HOST_STATE_CHANNEL = "t3x:self-host:state";
// Mirrors SELF_HOST_BRIDGE_GLOBAL in @t3tools/shared/selfHost, which the preload cannot require.
export const SELF_HOST_BRIDGE_GLOBAL = "t3xSelfHostBridge";
