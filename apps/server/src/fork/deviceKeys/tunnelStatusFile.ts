// fork: the tunnel's last status, written by the server (DeviceTunnel) beside the frpc config and read
// by `t3x devices tunnel status`, which runs in another process. It holds no secret.
//
// A pid alone says nothing (pids are reused), so the server also refreshes `updatedAt` every
// minute while it runs; the reader believes the file only while that is recent.
import * as Schema from "effect/Schema";

export const TUNNEL_DIR = "fork-tunnel";
export const TUNNEL_STATUS_FILE = "status.json";
export const TUNNEL_HEARTBEAT_SECONDS = 60;
/** Three missed heartbeats. */
const TUNNEL_STATUS_FRESH_MILLIS = 3 * 60 * 1000;

const StatusFile = Schema.Struct({
  serverPid: Schema.Number,
  frpcPid: Schema.NullOr(Schema.Number),
  status: Schema.String,
  lastError: Schema.NullOr(Schema.String),
  updatedAt: Schema.Number,
});
export type TunnelStatusFile = typeof StatusFile.Type;

export const encodeTunnelStatusFile = Schema.encodeSync(Schema.fromJsonString(StatusFile));
export const decodeTunnelStatusFile = Schema.decodeUnknownOption(Schema.fromJsonString(StatusFile));

/**
 * The server is running when its pid is alive and it has written in the last three minutes. An
 * `updatedAt` more than a minute ahead of this clock is not a heartbeat either.
 */
export const isServerRunning = (
  file: TunnelStatusFile,
  nowMillis: number,
  isPidAlive: (pid: number) => boolean,
): boolean => {
  const age = nowMillis - file.updatedAt;
  return age <= TUNNEL_STATUS_FRESH_MILLIS && age >= -60_000 && isPidAlive(file.serverPid);
};
