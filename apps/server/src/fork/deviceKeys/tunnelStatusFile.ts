// fork: the tunnel's last status, written by the server (DeviceTunnel) beside the frpc config and read
// by `t3x devices tunnel status`, which runs in another process. It holds no secret.
import * as Schema from "effect/Schema";

export const TUNNEL_DIR = "fork-tunnel";
export const TUNNEL_STATUS_FILE = "status.json";

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
