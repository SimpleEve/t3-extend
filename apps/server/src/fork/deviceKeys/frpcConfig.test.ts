// The config frpc is started with, and the ticket it logs in with, checked against the registry's real plugin.
import { decodeJws, generateDeviceKey } from "@t3tools/shared/forkDeviceKeys/jws";
import { assert, describe, it } from "@effect/vitest";

import {
  issueTicket,
  renderFrpcConfig,
  TICKET_LIFETIME_SECONDS,
  TICKET_ROTATION_SECONDS,
  frpcUser,
} from "./frpcConfig.ts";

const KEY = generateDeviceKey();
const NOW = 1_800_000_000;
const REGISTRY_ID = "regid123";
const binding = {
  key: KEY,
  registryId: REGISTRY_ID,
  subdomain: "studio",
  generation: 1234,
  nowSeconds: NOW,
};

interface RegistryPlugin {
  decide: (
    store: unknown,
    request: { op: string; content: unknown },
    now: number,
  ) => { reject: boolean; reject_reason?: string; unchange?: boolean };
}
const loadPlugin = async () =>
  (await import(
    /* @vite-ignore */ new URL(
      "../../../../../infra/self-host/registry/plugin.mjs",
      import.meta.url,
    ).href
  )) as RegistryPlugin;

/** The registry's view: one computer row, as `store.getDevice` would return it. */
const storeWith = (device: Record<string, unknown> | null) => ({
  registryId: REGISTRY_ID,
  getDevice: (id: string) => (device !== null && device.id === id ? device : null),
  touch: () => undefined,
});
const row = {
  id: KEY.id,
  kind: "computer",
  jwk: KEY.jwk,
  subdomain: "studio",
  createdAt: 1234,
};

describe("renderFrpcConfig", () => {
  const ticket = issueTicket(binding);
  const production = {
    registryOrigin: "https://t3.example.com",
    deviceId: KEY.id,
    subdomain: "studio",
    ticket,
    localPort: 40_123,
  };

  it("renders the production config exactly: wss, explicit heartbeat, no pool or CA setting, the listener's port", () => {
    assert.equal(
      renderFrpcConfig(production),
      [
        'serverAddr = "t3.example.com"',
        "serverPort = 443",
        `user = "${KEY.id.slice(0, 16)}"`,
        "loginFailExit = false",
        `metadatas.t3x_ticket = "${ticket}"`,
        "",
        'log.to = "console"',
        'log.level = "info"',
        "log.disablePrintColor = true",
        "",
        'transport.protocol = "wss"',
        "transport.heartbeatInterval = 30",
        "transport.heartbeatTimeout = 90",
        "",
        "[[proxies]]",
        'name = "t3x"',
        'type = "http"',
        'localIP = "127.0.0.1"',
        "localPort = 40123",
        'subdomain = "studio"',
        "",
      ].join("\n"),
    );
  });

  it("writes the test CA only when one is given, and takes the port from the origin", () => {
    const withCa = renderFrpcConfig({
      ...production,
      registryOrigin: "https://t3.localhost:18443",
      trustedCaFile: "/tmp/ca dir/root.crt",
    });
    assert.include(withCa, 'serverAddr = "t3.localhost"\nserverPort = 18443\n');
    assert.include(withCa, 'transport.tls.trustedCaFile = "/tmp/ca dir/root.crt"\n');
    assert.notInclude(renderFrpcConfig(production), "trustedCaFile");
  });

  it("never opens an admin port, sets a pool size, or carries key material", () => {
    const config = renderFrpcConfig(production);
    for (const forbidden of ["webServer", "poolCount", "adminAddr", "adminPort", KEY.jwk.x]) {
      assert.notInclude(config, forbidden);
    }
    assert.notInclude(config, Buffer.from(KEY.privateKey).toString("base64url"));
  });

  it("refuses values that could break out of the file", () => {
    for (const bad of [
      { subdomain: 'x"\nwebServer.port = 7400' },
      { subdomain: "UPPER" },
      { ticket: 'a.b.c"\n' },
      { ticket: "no-dots" },
      { deviceId: "short" },
      { localPort: 0 },
      { localPort: 70_000 },
      { registryOrigin: "http://t3.example.com" },
    ]) {
      assert.throws(() => renderFrpcConfig({ ...production, ...bad }));
    }
  });
});

describe("issueTicket", () => {
  it("binds the device, subdomain, registry and generation and lives 24 hours", () => {
    const decoded = decodeJws(issueTicket(binding));
    assert.equal(decoded.header.alg, "ES256");
    assert.equal(decoded.header.kid, KEY.id);
    assert.deepEqual(decoded.payload, {
      v: 1,
      iss: KEY.id,
      rid: REGISTRY_ID,
      sub: "studio",
      gen: 1234,
      iat: NOW,
      exp: NOW + 86_400,
    });
    assert.equal(TICKET_LIFETIME_SECONDS, 86_400);
    assert.equal(TICKET_ROTATION_SECONDS, 43_200);
    assert.equal(frpcUser(KEY.id), KEY.id.slice(0, 16));
  });

  it("is accepted by the registry's plugin for all four ops, and refused when it is not this device's", async () => {
    const { decide } = await loadPlugin();
    const ticket = issueTicket(binding);
    const user = frpcUser(KEY.id);
    const login = { op: "Login", content: { user, metas: { t3x_ticket: ticket } } };
    const ping = { op: "Ping", content: { user: { user, metas: { t3x_ticket: ticket } } } };
    const workConn = {
      op: "NewWorkConn",
      content: { user: { user, metas: { t3x_ticket: ticket } } },
    };
    const proxy = {
      op: "NewProxy",
      content: {
        user: { user, metas: { t3x_ticket: ticket } },
        proxy_type: "http",
        proxy_name: `${user}.t3x`,
        subdomain: "studio",
      },
    };
    for (const request of [login, ping, workConn, proxy]) {
      assert.deepEqual(decide(storeWith(row), request, NOW + 10), {
        reject: false,
        unchange: true,
      });
    }
    // Removed, rejoined (new generation), a different subdomain, or past its lifetime.
    assert.equal(decide(storeWith(null), ping, NOW + 10).reject_reason, "t3x:revoked");
    assert.equal(
      decide(storeWith({ ...row, createdAt: 9999 }), ping, NOW + 10).reject_reason,
      "t3x:bad-ticket",
    );
    assert.equal(
      decide(storeWith({ ...row, subdomain: "other" }), login, NOW + 10).reject_reason,
      "t3x:bad-ticket",
    );
    for (const request of [login, ping, workConn, proxy]) {
      assert.equal(
        decide(storeWith(row), request, NOW + TICKET_LIFETIME_SECONDS + 1).reject_reason,
        "t3x:ticket-expired",
      );
    }
  });
});
