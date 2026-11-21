// @effect-diagnostics nodeBuiltinImport:off -- A local forward proxy needs a real socket.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import {
  antigravityAuthConfigIssue,
  buildAntigravityAcpSpawnInput,
} from "./antigravityAuthSupport.ts";
import {
  antigravityNetworkProxyIssue,
  makeAntigravityProxyDispatcher,
  parseAntigravityNetworkProxy,
  withAntigravityNetworkProxy,
} from "./antigravityNetworkProxy.ts";

describe("Antigravity network proxy setting", () => {
  it("accepts HTTP and SOCKS proxy addresses, with credentials, and nothing else", () => {
    for (const value of [
      "http://127.0.0.1:7890",
      "https://proxy.example.com:8443",
      "socks5://127.0.0.1:1080",
      "socks5h://user:p%40ss@proxy.example.com:1080/",
    ]) {
      expect(parseAntigravityNetworkProxy(value)).toBeDefined();
      expect(antigravityNetworkProxyIssue(value)).toBeNull();
    }
    for (const value of [
      "127.0.0.1:7890",
      "ftp://proxy.example.com",
      "socks4://127.0.0.1:1080",
      "http://",
      "http://proxy.example.com/path",
      "http://proxy.example.com/?a=b",
      "not a url",
    ]) {
      expect(parseAntigravityNetworkProxy(value)).toBeUndefined();
      expect(antigravityNetworkProxyIssue(value)).toContain("network proxy");
    }
    // An empty setting is "no proxy", not a mistake.
    expect(antigravityNetworkProxyIssue("")).toBeNull();
    expect(antigravityNetworkProxyIssue("  ")).toBeNull();
    expect(antigravityNetworkProxyIssue(undefined)).toBeNull();
  });

  it("reports a bad proxy as a configuration issue for every sign-in method", () => {
    const auth = {
      apiKey: "key",
      gcpProject: "project",
      gcpLocation: "us-central1",
      networkProxy: "proxy.example.com:1080",
    } as const;
    for (const authMethod of [
      "oauth-personal",
      "oauth-business",
      "gemini-api-key",
      "agent-platform",
    ] as const) {
      expect(antigravityAuthConfigIssue({ ...auth, authMethod })).toContain("network proxy");
      expect(
        antigravityAuthConfigIssue({ ...auth, authMethod, networkProxy: "http://127.0.0.1:7890" }),
      ).toBeNull();
    }
  });
});

describe("Antigravity proxy environment", () => {
  it("leaves the environment byte for byte alone without a proxy", () => {
    const environment = {
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://machine.proxy:3128",
      no_proxy: "x",
    };
    expect(withAntigravityNetworkProxy(environment, undefined)).toBe(environment);
    expect(withAntigravityNetworkProxy(environment, "")).toBe(environment);
  });

  it("replaces the machine's proxy variables, of any case, and always exempts loopback", () => {
    const environment = {
      PATH: "/usr/bin",
      CUSTOM: "keep",
      HTTPS_PROXY: "http://machine.proxy:3128",
      http_proxy: "http://machine.proxy:3128",
      All_Proxy: "socks5://machine.proxy:1080",
      NO_PROXY: "internal.example.com, 10.0.0.0/8",
    };
    const result = withAntigravityNetworkProxy(environment, " socks5://127.0.0.1:1080 ");
    expect(result).toEqual({
      PATH: "/usr/bin",
      CUSTOM: "keep",
      HTTPS_PROXY: "socks5://127.0.0.1:1080",
      HTTP_PROXY: "socks5://127.0.0.1:1080",
      ALL_PROXY: "socks5://127.0.0.1:1080",
      NO_PROXY: "localhost,127.0.0.1,::1,internal.example.com,10.0.0.0/8",
      https_proxy: "socks5://127.0.0.1:1080",
      http_proxy: "socks5://127.0.0.1:1080",
      all_proxy: "socks5://127.0.0.1:1080",
      no_proxy: "localhost,127.0.0.1,::1,internal.example.com,10.0.0.0/8",
    });
    // The caller's own environment is not edited.
    expect(environment.HTTPS_PROXY).toBe("http://machine.proxy:3128");
  });

  it("reaches every agy launch through the spawn input, and never leaks a proxy into a direct one", () => {
    const profile = {
      platform: "linux",
      geminiHome: "/profile",
      acpDirectory: "/profile/antigravity-acp",
      tokenPath: "/profile/antigravity-acp/acp_token.json",
      tempDirectory: "/profile/antigravity-acp/tmp",
      browserCommand: "helper",
    } as const;
    const spawnFor = (networkProxy: string | undefined) =>
      buildAntigravityAcpSpawnInput({
        installation: { executablePath: "/usr/bin/agy" },
        profile,
        cwd: "/project",
        baseEnv: { PATH: "/usr/bin" },
        auth: {
          authMethod: "oauth-personal",
          apiKey: "",
          gcpProject: "",
          gcpLocation: "",
          ...(networkProxy === undefined ? {} : { networkProxy }),
        },
      }).env ?? {};
    expect(spawnFor("http://127.0.0.1:7890")).toMatchObject({
      HTTPS_PROXY: "http://127.0.0.1:7890/",
      NO_PROXY: "localhost,127.0.0.1,::1",
    });
    const direct = spawnFor(undefined);
    expect(Object.keys(direct).filter((key) => /proxy/i.test(key))).toEqual([]);
  });
});

const listenOnLoopback = (server: NodeHttp.Server) =>
  Effect.promise(
    () =>
      new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () =>
          resolve((server.address() as NodeNet.AddressInfo).port),
        );
      }),
  );

describe("Antigravity proxy dispatcher", () => {
  // The whole point of the setting: T3's own request leaves through the proxy, not directly.
  it.live(
    "sends a request through an HTTP proxy and refuses to go direct when none can be built",
    () =>
      Effect.gen(function* () {
        const forwarded: string[] = [];
        const proxy = NodeHttp.createServer((request, response) => {
          forwarded.push(`${request.method} ${request.url}`);
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ via: "proxy" }));
        });
        const proxyPort = yield* listenOnLoopback(proxy);
        yield* Effect.addFinalizer(() => Effect.sync(() => proxy.close()));

        const dispatcher = yield* makeAntigravityProxyDispatcher(`http://127.0.0.1:${proxyPort}`);
        expect(dispatcher).toBeDefined();
        expect(dispatcher).not.toBeNull();

        const init = { dispatcher } as unknown as RequestInit;
        const body = yield* HttpClient.HttpClient.pipe(
          Effect.flatMap((client) =>
            client.execute(HttpClientRequest.get("http://upstream.invalid/quota")),
          ),
          Effect.flatMap((response) => response.json),
          Effect.provideService(FetchHttpClient.RequestInit, init),
          Effect.provide(FetchHttpClient.layer),
        );
        expect(body).toEqual({ via: "proxy" });
        expect(forwarded).toEqual(["GET http://upstream.invalid/quota"]);

        expect(yield* makeAntigravityProxyDispatcher(undefined)).toBeUndefined();
        expect(yield* makeAntigravityProxyDispatcher("not a proxy")).toBeNull();
      }).pipe(Effect.scoped),
  );

  it.effect("builds a SOCKS5 dispatcher for socks5 and socks5h addresses", () =>
    Effect.gen(function* () {
      for (const address of ["socks5://127.0.0.1:1080", "socks5h://user:pw@127.0.0.1:1080"]) {
        expect(yield* makeAntigravityProxyDispatcher(address)).toBeTruthy();
      }
    }).pipe(Effect.scoped),
  );
});
