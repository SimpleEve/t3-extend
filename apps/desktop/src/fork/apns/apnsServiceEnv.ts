// @effect-diagnostics nodeBuiltinImport:off -- parseEnv is the parser the service uses for the same file.
import * as NodeUtil from "node:util";

// fork: the background service reads `<T3 home>/service.env`; the app's own backend must see the
// same APNs key, or iPhone push stops whenever the app is open. Only these names cross over: the
// rest of that file (port, host, LAN) is the service's, and the app decides those itself.
const APNS_SERVICE_ENV_NAMES = [
  "T3EXTEND_APNS_KEY_FILE",
  "T3EXTEND_APNS_KEY_ID",
  "T3EXTEND_APNS_TEAM_ID",
] as const;

export const SERVICE_ENV_FILE_NAME = "service.env";

export function apnsEnvironmentFromServiceEnv(contents: string): Record<string, string> {
  const parsed = NodeUtil.parseEnv(contents);
  const picked: Record<string, string> = {};
  for (const name of APNS_SERVICE_ENV_NAMES) {
    const value = parsed[name];
    if (value !== undefined) picked[name] = value;
  }
  return picked;
}
