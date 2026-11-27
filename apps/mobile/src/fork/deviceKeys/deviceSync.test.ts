import type { RegistryDevice } from "@t3tools/contracts";
import { parseAssertion, verifyAssertionSignature } from "@t3tools/shared/forkDeviceKeys/assertion";
import { encodeInvite, type InviteKind } from "@t3tools/shared/forkDeviceKeys/invite";
import { deviceIdOf, type DeviceJwk } from "@t3tools/shared/forkDeviceKeys/jws";
import { verifyRequestProof } from "@t3tools/shared/forkDeviceKeys/proof";
import { describe, expect, it } from "vite-plus/test";

import { DEVICE_KEY_ITEM, type SecretStore } from "./deviceKey";
import {
  MEMBERSHIP_ITEM,
  REFRESH_INTERVAL_MS,
  createDeviceSync,
  type DeviceSyncState,
} from "./deviceSync";
import type { RegistryFetch } from "./registryClient";

const ORIGIN = "https://t3.example.com";
const REGISTRY_ID = "abcdefgh";
const START = 1_800_000_000;

const memoryStore = (initial: Record<string, string> = {}) => {
  const items = new Map(Object.entries(initial));
  const deleted: string[] = [];
  const store: SecretStore = {
    getItemAsync: async (key) => items.get(key) ?? null,
    setItemAsync: async (key, value) => void items.set(key, value),
    deleteItemAsync: async (key) => {
      deleted.push(key);
      items.delete(key);
    },
  };
  return { store, items, deleted };
};

const mac: RegistryDevice = {
  id: "mac-id",
  name: "Mac",
  kind: "computer",
  jwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
  subdomain: "mac",
  url: "https://mac.t3.example.com",
  environmentId: "env-mac",
  createdAt: 1,
  lastSeenAt: START - 60,
  online: true,
};

/** A registry the phone talks to; it checks every proof the way the real one does. */
function fakeRegistry(options: { registryId?: string } = {}) {
  const requests: Array<{ method: string; url: string; headers: Headers; body: Uint8Array }> = [];
  const devices = new Map<string, RegistryDevice>([[mac.id, mac]]);
  let rev = 1;
  const state = {
    now: START,
    // Overrides: the next answer for a path.
    reply: new Map<string, () => Response>(),
    inviteSecret: "B".repeat(22),
    usedInvite: false,
    joinedAs: undefined as string | undefined,
    proofsChecked: 0,
    unreachable: false,
    // Computers that hide from the asking phone: left out of `devices`, listed by identity only.
    hidden: new Set<string>(),
  };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers });

  const fetchImpl = (async (input: string, init: Parameters<RegistryFetch>[1]) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body =
      init?.body === undefined ? new Uint8Array() : new Uint8Array(init.body as Uint8Array);
    const headers = new Headers(init?.headers);
    requests.push({ method, url, headers, body });
    if (state.unreachable) throw new TypeError("network down");
    const path = new URL(url).pathname;
    const forced = state.reply.get(path);
    if (forced) return forced();
    if (path === "/v1/info") {
      return json(200, {
        apiVersion: 1,
        registryId: options.registryId ?? REGISTRY_ID,
        domain: "t3.example.com",
        publicPort: 443,
      });
    }
    const check = (jwk: DeviceJwk) => {
      verifyRequestProof(headers.get("t3x-proof")!, {
        jwk,
        method,
        htu: url,
        now: state.now,
        body,
      });
      state.proofsChecked += 1;
    };
    if (path === "/v1/join") {
      const request = JSON.parse(new TextDecoder().decode(body)) as {
        invite: string;
        device: { name: string; kind: string; jwk: DeviceJwk };
      };
      check(request.device.jwk);
      if (state.usedInvite) return json(409, { error: "invite_used" });
      if (request.invite !== `AAAAAAAAAAA.${state.inviteSecret}`) {
        return json(400, { error: "invite_invalid" });
      }
      state.usedInvite = true;
      const id = deviceIdOf(request.device.jwk);
      state.joinedAs = id;
      devices.set(id, {
        id,
        name: request.device.name,
        kind: "phone",
        jwk: request.device.jwk,
        createdAt: state.now,
        lastSeenAt: state.now,
      });
      rev += 1;
      return json(201, {
        registryId: options.registryId ?? REGISTRY_ID,
        deviceId: id,
        name: request.device.name,
        rev,
      });
    }
    if (path === "/v1/devices") {
      const kid = JSON.parse(
        new TextDecoder().decode(
          Uint8Array.from(
            atob(headers.get("t3x-proof")!.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/")),
            (c) => c.charCodeAt(0),
          ),
        ),
      ).kid as string;
      const caller = devices.get(kid);
      if (caller === undefined) return json(401, { error: "device_unknown" });
      check(caller.jwk);
      // Like the registry: `online` and the sync times move without `rev`, so there is no 304.
      const all = [...devices.values()];
      const hiddenPeers = all
        .filter((d) => state.hidden.has(d.id))
        .map(({ id, kind, jwk }) => ({ id, kind, jwk }));
      return json(200, {
        registryId: options.registryId ?? REGISTRY_ID,
        rev,
        devices: all.filter((d) => !state.hidden.has(d.id)),
        ...(hiddenPeers.length === 0 ? {} : { hiddenPeers }),
      });
    }
    return json(404, { error: "not_found" });
  }) satisfies RegistryFetch;

  return {
    requests,
    state,
    devices,
    fetch: fetchImpl,
    bumpRev: () => void (rev += 1),
    remove: (id: string) => {
      devices.delete(id);
      rev += 1;
    },
  };
}

const invite = (
  overrides: Partial<{ kind: InviteKind; origin: string; ttl: number; registryId: string }> = {},
) =>
  encodeInvite({
    origin: overrides.origin ?? ORIGIN,
    registryId: overrides.registryId ?? REGISTRY_ID,
    id: "AAAAAAAAAAA",
    secret: "B".repeat(22),
    kind: overrides.kind ?? "phone",
    expiresAt: START + (overrides.ttl ?? 900),
  });

function setup(registryOptions: { registryId?: string } = {}, stored: Record<string, string> = {}) {
  const registry = fakeRegistry(registryOptions);
  const storage = memoryStore(stored);
  const views: Array<unknown> = [];
  let counter = 0;
  const sync = createDeviceSync({
    store: storage.store,
    registry: {
      fetch: registry.fetch,
      randomBytes: (count) => Uint8Array.from({ length: count }, () => ((counter += 37) % 251) + 1),
      nowSeconds: () => registry.state.now,
    },
    applyView: async (view) => void views.push(view),
  });
  return { registry, storage, views, sync };
}

const joinedState = (state: DeviceSyncState) => {
  if (state._tag !== "joined") throw new Error(`expected joined, was ${state._tag}`);
  return state;
};

describe("joining a server from the phone", () => {
  it.each([
    ["not an invite", "hello", "invalid"],
    ["an empty paste", "  ", "invalid"],
    ["an invite for a computer", invite({ kind: "computer" }), "wrong-kind"],
    ["an expired invite", invite({ ttl: -1 }), "expired"],
  ] as const)("sends nothing for %s", async (_name, text, failure) => {
    const { sync, registry, storage } = setup();
    await sync.load();
    expect(await sync.join(text, "Pixel")).toEqual({ ok: false, failure });
    expect(registry.requests).toEqual([]);
    expect(storage.items.size).toBe(0);
  });

  it("checks who answers at the address before it sends the invite, then joins and lists", async () => {
    const { sync, registry, storage, views } = setup();
    await sync.load();
    expect(await sync.join(invite(), "Pixel")).toEqual({ ok: true });

    expect(registry.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      "GET /v1/info",
      "POST /v1/join",
      "GET /v1/devices",
    ]);
    expect(registry.state.proofsChecked).toBe(2);
    const state = joinedState(sync.state());
    expect(state.membership).toMatchObject({
      origin: ORIGIN,
      registryId: REGISTRY_ID,
      name: "Pixel",
    });
    expect(state.membership.deviceId).toBe(registry.state.joinedAs);
    expect(storage.items.has(DEVICE_KEY_ITEM)).toBe(true);
    expect(storage.items.has(MEMBERSHIP_ITEM)).toBe(true);
    // Only the computers go to the connection code, pinned to this registry.
    expect(views).toEqual([
      {
        pin: { origin: ORIGIN, registryId: REGISTRY_ID },
        recordsEnvironmentIds: true,
        computers: [
          {
            deviceId: "mac-id",
            name: "Mac",
            url: "https://mac.t3.example.com",
            environmentId: "env-mac",
            self: false,
            online: true,
          },
        ],
      },
    ]);
  });

  it("refuses a registry that is not the one the invite was made for, before any key is made", async () => {
    const { sync, registry, storage } = setup({ registryId: "zzzzzzzz" });
    await sync.load();
    expect(await sync.join(invite(), "Pixel")).toEqual({ ok: false, failure: "wrong-server" });
    expect(registry.requests.map((r) => new URL(r.url).pathname)).toEqual(["/v1/info"]);
    expect(storage.items.size).toBe(0);
  });

  it.each([
    ["invite_used", 409, "invite-used"],
    ["invite_expired", 410, "invite-expired"],
    ["name_invalid", 400, "name-invalid"],
    ["rate_limited", 429, "rate-limited"],
    ["invite_invalid", 400, "invite-invalid"],
  ] as const)("names a rejected invite (%s) and keeps no key", async (code, status, failure) => {
    const { sync, registry, storage } = setup();
    await sync.load();
    registry.state.reply.set(
      "/v1/join",
      () => new Response(JSON.stringify({ error: code }), { status }),
    );
    expect(await sync.join(invite(), "Pixel")).toEqual({ ok: false, failure });
    expect(storage.items.size).toBe(0);
    expect(sync.state()).toEqual({ _tag: "not-joined", removed: false });
  });

  it("does not believe a join answer for another device or another registry", async () => {
    for (const answer of [
      { registryId: REGISTRY_ID, deviceId: "someone-else", name: "Pixel", rev: 2 },
      { registryId: "zzzzzzzz", deviceId: "x", name: "Pixel", rev: 2 },
    ]) {
      const { sync, registry, storage } = setup();
      await sync.load();
      registry.state.reply.set(
        "/v1/join",
        () => new Response(JSON.stringify(answer), { status: 201 }),
      );
      expect(await sync.join(invite(), "Pixel")).toMatchObject({ ok: false });
      expect(storage.items.size).toBe(0);
    }
  });

  it("is unreachable, not joined, when the registry does not answer", async () => {
    const { sync, registry, storage } = setup();
    await sync.load();
    registry.state.unreachable = true;
    expect(await sync.join(invite(), "Pixel")).toEqual({ ok: false, failure: "unreachable" });
    expect(storage.items.size).toBe(0);
  });

  it.each([
    [
      "a 302",
      () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example/v1/info" } }),
    ],
    // Some runtimes follow redirects whatever `manual` asks for and hand back the final answer.
    [
      "a followed redirect",
      () =>
        Object.defineProperty(
          new Response(
            JSON.stringify({
              apiVersion: 1,
              registryId: REGISTRY_ID,
              domain: "evil.example",
              publicPort: 443,
            }),
            { status: 200 },
          ),
          "redirected",
          { value: true },
        ),
    ],
    [
      "an answer from another address",
      () =>
        Object.defineProperty(
          new Response(
            JSON.stringify({
              apiVersion: 1,
              registryId: REGISTRY_ID,
              domain: "evil.example",
              publicPort: 443,
            }),
            { status: 200 },
          ),
          "url",
          { value: "https://evil.example/v1/info" },
        ),
    ],
  ])("refuses %s as an answer", async (_name, answer) => {
    const { sync, registry } = setup();
    await sync.load();
    registry.state.reply.set("/v1/info", answer);
    expect(await sync.join(invite(), "Pixel")).toEqual({ ok: false, failure: "wrong-server" });
    expect(registry.requests).toHaveLength(1);
  });
});

describe("keeping the list current", () => {
  async function joined() {
    const context = setup();
    await context.sync.load();
    await context.sync.join(invite(), "Pixel");
    context.registry.requests.length = 0;
    context.views.length = 0;
    return context;
  }

  it("checks at most every thirty seconds unless asked, and shares a round trip in flight", async () => {
    const { sync, registry } = await joined();
    registry.state.now += REFRESH_INTERVAL_MS / 1000 - 1;
    await sync.refresh();
    expect(registry.requests).toHaveLength(0);
    registry.state.now += 1;
    await Promise.all([sync.refresh(), sync.refresh()]);
    expect(registry.requests).toHaveLength(1);
    await sync.refresh({ force: true });
    expect(registry.requests).toHaveLength(2);
  });

  it("asks for the whole list every time, and takes a change that did not move rev", async () => {
    const { sync, registry, views } = await joined();
    registry.state.now += 45;
    await sync.refresh({ force: true });
    expect(registry.requests[0]!.headers.get("if-none-match")).toBeNull();
    expect(joinedState(sync.state())).toMatchObject({
      fetchedAt: registry.state.now,
      unreachable: false,
    });
    // The connection code gets the list each time; it does nothing for one it already has.
    expect(views).toHaveLength(1);

    const rev = joinedState(sync.state()).rev;
    registry.devices.set("mac-id", { ...mac, online: true, lastSeenAt: registry.state.now });
    registry.state.now += 60;
    await sync.refresh({ force: true });
    const after = joinedState(sync.state());
    expect(after.rev).toBe(rev);
    expect(after.devices.find((d) => d.id === "mac-id")?.online).toBe(true);
    expect(views).toHaveLength(2);
  });

  it("treats a computer that hides from this phone as gone, and the phone itself as still joined", async () => {
    const { sync, registry, views, storage } = await joined();
    registry.state.now += 45;
    await sync.refresh({ force: true });
    expect(joinedState(sync.state()).devices.map((d) => d.id)).toContain("mac-id");

    registry.state.hidden.add("mac-id");
    registry.state.now += 45;
    await sync.refresh({ force: true });
    const hidden = joinedState(sync.state());
    expect(hidden.unreachable).toBe(false);
    expect(hidden.devices.map((d) => d.id)).toEqual([registry.state.joinedAs]);
    // The connection code is handed a list without the computer, as it would after a removal.
    const view = views.at(-1) as { computers: ReadonlyArray<{ deviceId: string }> } | null;
    expect(view).not.toBeNull();
    expect(view!.computers.map((c) => c.deviceId)).toEqual([]);
    // Nothing of this phone is forgotten: no "removed", no key deleted.
    expect(storage.deleted).toEqual([]);
    expect(storage.items.has(MEMBERSHIP_ITEM)).toBe(true);

    // Shown again: the next refresh brings it back.
    registry.state.hidden.delete("mac-id");
    registry.state.now += 45;
    await sync.refresh({ force: true });
    expect(joinedState(sync.state()).devices.map((d) => d.id)).toContain("mac-id");
    const back = views.at(-1) as { computers: ReadonlyArray<{ deviceId: string }> };
    expect(back.computers.map((c) => c.deviceId)).toEqual(["mac-id"]);
  });

  it("treats a 304 as a protocol error, never as an answer", async () => {
    const { sync, registry, views } = await joined();
    const before = joinedState(sync.state());
    registry.state.reply.set("/v1/devices", () => new Response(null, { status: 304 }));
    registry.state.now += 45;
    await sync.refresh({ force: true });
    const after = joinedState(sync.state());
    expect(after.unreachable).toBe(true);
    expect(after.fetchedAt).toBe(before.fetchedAt);
    expect(after.devices).toBe(before.devices);
    expect(views).toEqual([]);
    expect(sync.state()._tag).toBe("joined");
  });

  it("keeps what it had and says so when the registry cannot be reached", async () => {
    const { sync, registry, views } = await joined();
    const before = joinedState(sync.state());
    registry.state.unreachable = true;
    registry.state.now += 600;
    await sync.refresh({ force: true });
    const after = joinedState(sync.state());
    expect(after.unreachable).toBe(true);
    expect(after.devices).toBe(before.devices);
    expect(after.fetchedAt).toBe(before.fetchedAt);
    expect(views).toEqual([]);
    registry.state.unreachable = false;
    await sync.refresh({ force: true });
    expect(joinedState(sync.state()).unreachable).toBe(false);
  });

  it("drops a list that comes from another registry", async () => {
    const { sync, registry, views } = await joined();
    registry.state.reply.set(
      "/v1/devices",
      () =>
        new Response(JSON.stringify({ registryId: "zzzzzzzz", rev: 99, devices: [] }), {
          status: 200,
        }),
    );
    await sync.refresh({ force: true });
    const state = joinedState(sync.state());
    expect(state.unreachable).toBe(true);
    expect(state.devices.map((d) => d.id)).toContain("mac-id");
    expect(views).toEqual([]);
  });

  it("forgets the server, its saved computers and the key once the registry says it was removed", async () => {
    const { sync, registry, storage, views } = await joined();
    registry.remove(registry.state.joinedAs!);
    await sync.refresh({ force: true });
    expect(sync.state()).toEqual({ _tag: "not-joined", removed: true });
    // The saved environments go first, so nothing keeps a way in while the rest is deleted.
    expect(views).toEqual([null]);
    expect(storage.deleted).toEqual([MEMBERSHIP_ITEM, DEVICE_KEY_ITEM]);
    expect(storage.items.size).toBe(0);
    expect(sync.currentView()).toBeNull();
  });

  it("leaving does the same without calling the registry", async () => {
    const { sync, registry, storage, views } = await joined();
    await sync.leave();
    expect(sync.state()).toEqual({ _tag: "not-joined", removed: false });
    expect(views).toEqual([null]);
    expect(registry.requests).toEqual([]);
    expect(storage.items.size).toBe(0);
  });

  it("ignores an answer that arrives after the phone left", async () => {
    const { sync, registry, views } = await joined();
    const pending = sync.refresh({ force: true });
    await sync.leave();
    await pending;
    expect(sync.state()).toEqual({ _tag: "not-joined", removed: false });
    expect(views).toEqual([null]);
    expect(registry.requests).toHaveLength(1);
  });
});

describe("starting up", () => {
  async function stored() {
    const first = setup();
    await first.sync.load();
    await first.sync.join(invite(), "Pixel");
    return Object.fromEntries(first.storage.items);
  }

  it("comes back joined from the keychain, without a list until the registry answers", async () => {
    const items = await stored();
    const { sync } = setup({}, items);
    await sync.load();
    expect(joinedState(sync.state()).devices).toEqual([]);
    expect(sync.currentView()).toBeNull();
  });

  it("cleans up a key left by a join that never finished", async () => {
    const items = await stored();
    delete items[MEMBERSHIP_ITEM];
    const { sync, storage } = setup({}, items);
    await sync.load();
    expect(sync.state()).toEqual({ _tag: "not-joined", removed: false });
    expect(storage.items.size).toBe(0);
  });

  it.each([
    [
      "a key that was damaged",
      (items: Record<string, string>) => ({ ...items, [DEVICE_KEY_ITEM]: "{" }),
    ],
    [
      "a membership that was damaged",
      (items: Record<string, string>) => ({ ...items, [MEMBERSHIP_ITEM]: "{" }),
    ],
    [
      "a membership for another key",
      (items: Record<string, string>) => ({
        ...items,
        [MEMBERSHIP_ITEM]: JSON.stringify({
          ...JSON.parse(items[MEMBERSHIP_ITEM]!),
          deviceId: "other",
        }),
      }),
    ],
    [
      "a membership whose address is not a bare origin",
      (items: Record<string, string>) => ({
        ...items,
        [MEMBERSHIP_ITEM]: JSON.stringify({
          ...JSON.parse(items[MEMBERSHIP_ITEM]!),
          origin: `${ORIGIN}/x`,
        }),
      }),
    ],
  ])("treats %s as damaged and changes nothing", async (_name, damage) => {
    const items = damage(await stored());
    const { sync, storage, registry } = setup({}, items);
    await sync.load();
    expect(sync.state()).toEqual({ _tag: "damaged" });
    expect(storage.deleted).toEqual([]);
    await sync.refresh({ force: true });
    expect(registry.requests).toEqual([]);
  });

  it("changes nothing while the keychain will not answer, and picks up the saved membership once it does", async () => {
    const items = await stored();
    const storage = memoryStore(items);
    let locked = true;
    const sync = createDeviceSync({
      store: {
        ...storage.store,
        getItemAsync: async (key) => {
          if (locked) throw new Error("locked");
          return storage.store.getItemAsync(key);
        },
      },
      registry: {
        fetch: fakeRegistry().fetch,
        randomBytes: () => new Uint8Array(32),
        nowSeconds: () => START,
      },
      applyView: async () => {},
    });
    await sync.load();
    expect(sync.state()).toEqual({ _tag: "storage-error" });
    expect(storage.deleted).toEqual([]);

    // The phone was unlocked and the app came to the foreground: load runs again.
    locked = false;
    await sync.load();
    expect(sync.state()._tag).toBe("joined");
  });
});

describe("signing a pass for a computer", () => {
  it("signs with the phone's own key, for one computer and one DPoP key", async () => {
    const { sync, registry } = setup();
    await sync.load();
    expect(sync.signPass({ audienceEnvironmentId: "env-mac", dpopThumbprint: "jkt" })).toBeNull();
    await sync.join(invite(), "Pixel");
    const pass = sync.signPass({ audienceEnvironmentId: "env-mac", dpopThumbprint: "jkt" })!;
    const parsed = parseAssertion(pass);
    expect(parsed.kid).toBe(registry.state.joinedAs);
    expect(parsed.claims).toMatchObject({
      iss: registry.state.joinedAs,
      aud: "env-mac",
      rid: REGISTRY_ID,
      jkt: "jkt",
    });
    expect(parsed.claims.exp - parsed.claims.iat).toBeLessThanOrEqual(120);
    expect(
      verifyAssertionSignature(parsed, registry.devices.get(registry.state.joinedAs!)!.jwk),
    ).toBe(true);
    await sync.leave();
    expect(sync.signPass({ audienceEnvironmentId: "env-mac", dpopThumbprint: "jkt" })).toBeNull();
  });
});
