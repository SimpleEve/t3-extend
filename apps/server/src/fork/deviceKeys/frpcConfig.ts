// fork: what this computer tells frpc, and the ticket frpc logs in with (design 3.7). Pure: nothing
// here reads a file or starts a process, so the exact bytes of the config can be asserted.
import { signTicket } from "@t3tools/shared/forkDeviceKeys/proof";
import type { DeviceKeyPair } from "@t3tools/shared/forkDeviceKeys/jws";

/** The registry's `Login` also rejects past this; frpc has no way to refresh it, so the server replaces it. */
export const TICKET_LIFETIME_SECONDS = 24 * 60 * 60;
/** Half the lifetime, so a rotation that is late by hours still lands before the ticket expires. */
export const TICKET_ROTATION_SECONDS = 12 * 60 * 60;

/** Name of the one proxy this computer registers; the registry's `NewProxy` expects `<user>.t3x`. */
const PROXY_NAME = "t3x";

export const frpcUser = (deviceId: string): string => deviceId.slice(0, 16);

export interface TicketBinding {
  readonly key: Pick<DeviceKeyPair, "privateKey" | "id">;
  readonly registryId: string;
  readonly subdomain: string;
  /** The device row's `created_at`: a computer that leaves and joins again gets a new one. */
  readonly generation: number;
  readonly nowSeconds: number;
  /** Tests only: a ticket that expires sooner than a day, to watch the renewal. */
  readonly lifetimeSeconds?: number | undefined;
}

export const issueTicket = (binding: TicketBinding): string =>
  signTicket({
    privateKey: binding.key.privateKey,
    kid: binding.key.id,
    rid: binding.registryId,
    sub: binding.subdomain,
    gen: binding.generation,
    iat: binding.nowSeconds,
    exp: binding.nowSeconds + (binding.lifetimeSeconds ?? TICKET_LIFETIME_SECONDS),
  });

export interface FrpcConfigInput {
  readonly registryOrigin: string;
  readonly deviceId: string;
  readonly subdomain: string;
  readonly ticket: string;
  /** The tunnel listener's port, not the server's main one (3.11). */
  readonly localPort: number;
  /** Tests only: the root that signed the registry's certificate. Production uses the system store. */
  readonly trustedCaFile?: string | undefined;
}

const TICKET_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const SUBDOMAIN_SHAPE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const DEVICE_ID_SHAPE = /^[A-Za-z0-9_-]{16,}$/;

/** A TOML basic string. JSON's escapes are valid TOML except that DEL must be escaped too. */
const tomlString = (value: string): string => JSON.stringify(value).replaceAll("\u007f", "\\u007f");

/**
 * The config frpc runs with. It carries no private key, opens no admin web server (frpc listens on
 * nothing), keeps retrying after a rejected login, and leaves `poolCount` at frp's default: setting
 * it to 0 did not make a revocation take effect any earlier (design Q6, measured in 8.1).
 */
export const renderFrpcConfig = (input: FrpcConfigInput): string => {
  const origin = new URL(input.registryOrigin);
  if (origin.protocol !== "https:") throw new Error("The server address must be https.");
  const host = origin.hostname.replace(/^\[|\]$/g, "");
  const serverPort = origin.port === "" ? 443 : Number(origin.port);
  if (host === "" || !Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65_535) {
    throw new Error("The server address is not usable.");
  }
  if (!DEVICE_ID_SHAPE.test(input.deviceId)) throw new Error("The device id is not usable.");
  if (!SUBDOMAIN_SHAPE.test(input.subdomain)) throw new Error("The subdomain is not usable.");
  if (!TICKET_SHAPE.test(input.ticket) || input.ticket.length > 2048) {
    throw new Error("The ticket is not usable.");
  }
  if (!Number.isInteger(input.localPort) || input.localPort < 1 || input.localPort > 65_535) {
    throw new Error("The tunnel listener port is not usable.");
  }

  return [
    `serverAddr = ${tomlString(host)}`,
    `serverPort = ${serverPort}`,
    `user = ${tomlString(frpcUser(input.deviceId))}`,
    "loginFailExit = false",
    `metadatas.t3x_ticket = ${tomlString(input.ticket)}`,
    "",
    'log.to = "console"',
    'log.level = "info"',
    "log.disablePrintColor = true",
    "",
    'transport.protocol = "wss"',
    "transport.heartbeatInterval = 30",
    "transport.heartbeatTimeout = 90",
    ...(input.trustedCaFile === undefined
      ? []
      : [`transport.tls.trustedCaFile = ${tomlString(input.trustedCaFile)}`]),
    "",
    "[[proxies]]",
    `name = ${tomlString(PROXY_NAME)}`,
    'type = "http"',
    'localIP = "127.0.0.1"',
    `localPort = ${input.localPort}`,
    `subdomain = ${tomlString(input.subdomain)}`,
    "",
  ].join("\n");
};
