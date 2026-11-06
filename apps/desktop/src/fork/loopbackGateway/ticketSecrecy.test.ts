// @effect-diagnostics nodeBuiltinImport:off -- Captures process output and drives real loopback sockets.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeUtil from "node:util";

import {
  LoopbackGatewayRegisterInput,
  LoopbackGatewayUpdateTicketInput,
  type LoopbackGatewayEvent,
} from "@t3tools/shared/forkLoopbackGateway/bridge";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Electron from "electron";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { startFakeGateway } from "./fakeGateway.testkit.ts";
import { makeLoopbackGatewayHost, type LoopbackGatewayHost } from "./LoopbackGatewayHost.ts";
import { proxyAuthorization, requestViaProxy } from "./proxyClient.testkit.ts";

// Long enough that no 12-character piece of it can appear by chance.
const SENTINEL = "sentinel-ticket-Zq8vXk2LmN4pR7sT.signature-Wd5hYb3Fc9Gj1Ea";

const decodeRegister = Schema.decodeUnknownSync(LoopbackGatewayRegisterInput);
const decodeUpdateTicket = Schema.decodeUnknownSync(LoopbackGatewayUpdateTicketInput);
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const pieces = (secret: string): ReadonlyArray<string> => {
  const found: Array<string> = [];
  for (let at = 0; at + 12 <= secret.length; at += 1) found.push(secret.slice(at, at + 12));
  return found;
};

const expectNoTrace = (haystack: string, ...secrets: ReadonlyArray<string>) => {
  for (const secret of secrets) {
    expect(haystack).not.toContain(secret);
    for (const piece of pieces(secret)) expect(haystack).not.toContain(piece);
  }
};

describe("the ticket in the main process", () => {
  it("stays out of console output, process output, events, errors and statuses on every path", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const output: Array<string> = [];
    const capture = (...args: ReadonlyArray<unknown>) => {
      output.push(
        args.map((arg) => (typeof arg === "string" ? arg : NodeUtil.inspect(arg))).join(" "),
      );
    };
    for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
      vi.spyOn(console, method).mockImplementation(capture);
    }
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    });

    const service = NodeHttp.createServer((_request, response) => response.end("fine"));
    await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => {
      service.closeAllConnections();
      return new Promise<void>((resolve) => service.close(() => resolve()));
    });
    const servicePort = (service.address() as NodeNet.AddressInfo).port;

    const gateway = await startFakeGateway({
      ticket: SENTINEL,
      refuse: (port) => (port === 4001 ? "not-owned" : port === 4002 ? "debug-process" : undefined),
    });
    cleanups.push(() => gateway.close());
    const redirecting = await startFakeGateway({
      ticket: SENTINEL,
      redirectTo: "http://127.0.0.1:1/",
    });
    cleanups.push(() => redirecting.close());

    const events: Array<LoopbackGatewayEvent> = [];
    const errors: Array<unknown> = [];
    const host: LoopbackGatewayHost = makeLoopbackGatewayHost({
      emit: (event) => events.push(event),
    });
    cleanups.push(() => host.dispose());
    const expires = DateTime.makeUnsafe(NOW + 5 * 60_000);
    const credential = (ticket: string) => ({ ticket: Redacted.make(ticket), expiresAt: expires });

    /** Registers an environment, hands it a session, and returns what a webview would use. */
    const connect = async (
      environmentId: string,
      httpBaseUrl: string,
      ticket: string,
    ): Promise<{ readonly port: number; readonly authorization: string }> => {
      let port = 0;
      const session = {
        setProxy: async (config: Electron.ProxyConfig) => {
          port = Number(/:(\d+)$/u.exec(config.proxyRules ?? "")?.[1]);
        },
        closeAllConnections: async () => {},
        webRequest: { onHeadersReceived: () => {} },
      } as unknown as Electron.Session;
      await host.register({
        environmentId,
        httpBaseUrl,
        enabled: true,
        credential: credential(ticket),
      });
      await host.installSession(environmentId, session);
      const answer = host.answerProxyLogin({ isProxy: true, host: "127.0.0.1", port, session });
      return { port, authorization: proxyAuthorization(answer!.username, answer!.password) };
    };
    const reach = async (proxy: { port: number; authorization: string }, port: number) => {
      try {
        return await requestViaProxy(proxy.port, proxy.authorization, `http://localhost:${port}/`);
      } catch (error) {
        errors.push(error);
        return undefined;
      }
    };

    // Success, a port the gateway refuses, one it cannot dial, a wrong ticket, a redirect, a dead
    // server, a renewed ticket, and a ticket of the wrong shape.
    const ok = await connect("ok", gateway.baseUrl, SENTINEL);
    const results = [
      await reach(ok, servicePort),
      await reach(ok, 4001),
      await reach(ok, 4002),
      await reach(ok, 1),
    ];
    expect(results[0]?.body).toBe("fine");
    expect(results[1]?.headers["x-t3x-gateway-error"]).toBe("not-owned");
    expect(results[2]?.headers["x-t3x-gateway-error"]).toBe("debug-process");
    expect(results[3]?.headers["x-t3x-gateway-error"]).toBe("upstream-refused");

    await reach(await connect("wrong", gateway.baseUrl, `${SENTINEL}x`), servicePort);
    await reach(await connect("redirected", redirecting.baseUrl, SENTINEL), servicePort);
    await reach(await connect("gone", "http://127.0.0.1:1", SENTINEL), servicePort);
    await host.updateTicket("ok", credential(`${SENTINEL}-renewed`));
    await host.setEnabled("ok", false);
    await host.register({
      environmentId: "bad-shape",
      httpBaseUrl: gateway.baseUrl,
      enabled: true,
    });
    await host
      .updateTicket("bad-shape", credential(`${SENTINEL} with spaces`))
      .catch((error: unknown) => errors.push(error));
    expect(errors).toHaveLength(1);

    const everything = [
      output.join("\n"),
      JSON.stringify(events),
      errors.map((error) => `${(error as Error).message}\n${(error as Error).stack}`).join("\n"),
      NodeUtil.inspect(events, { depth: 10 }),
    ].join("\n");
    expect(output).toEqual([]);
    expectNoTrace(everything, SENTINEL);
  });

  it("is found by the scan when it does leak", () => {
    expect(() => expectNoTrace(`leaked: ${SENTINEL.slice(4, 20)}`, SENTINEL)).toThrow();
  });

  it("is a Redacted value from the moment the IPC payload is decoded", () => {
    const decoded = decodeRegister({
      environmentId: "env-b",
      httpBaseUrl: "https://b.example.com",
      enabled: true,
      credential: { ticket: SENTINEL, expiresAt: "2026-11-04T12:05:00.000Z" },
    });
    const ticket = decoded.credential!.ticket;
    expect(Redacted.isRedacted(ticket)).toBe(true);
    expect(Redacted.value(ticket)).toBe(SENTINEL);
    expectNoTrace(
      [String(ticket), JSON.stringify(decoded), NodeUtil.inspect(decoded, { depth: 10 })].join(
        "\n",
      ),
      SENTINEL,
    );
  });

  it("is not in the message of a payload that fails to decode", () => {
    for (const payload of [
      { environmentId: "env-b", credential: { ticket: SENTINEL, expiresAt: "not a date" } },
      {
        environmentId: "",
        credential: { ticket: SENTINEL, expiresAt: "2026-11-04T12:05:00.000Z" },
      },
      {
        environmentId: "env-b",
        credential: { ticket: 12345, expiresAt: "2026-11-04T12:05:00.000Z" },
      },
    ]) {
      let message = "";
      try {
        decodeUpdateTicket(payload);
      } catch (error) {
        message = String((error as Error).message);
      }
      expect(message).not.toBe("");
      expectNoTrace(message, SENTINEL);
    }
  });
});
