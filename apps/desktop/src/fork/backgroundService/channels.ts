// Kept free of imports: the sandboxed preload bundles this file.
export const GET_BACKGROUND_SERVICE_STATE_CHANNEL = "t3x:background-service:get-state";
export const SET_BACKGROUND_SERVICE_ENABLED_CHANNEL = "t3x:background-service:set-enabled";
// Mirrors BACKGROUND_SERVICE_BRIDGE_GLOBAL in @t3tools/shared/backgroundService, which the preload cannot require.
export const BACKGROUND_SERVICE_BRIDGE_GLOBAL = "t3xBackgroundServiceBridge";
