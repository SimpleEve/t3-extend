// The real 8.1 registry (`infra/self-host/registry/server.mjs`) as a subprocess on loopback ports and a
// temp data directory, plus an HttpClient that sends the `https://` registry origin to that port.
// @effect-diagnostics nodeBuiltinImport:off -- Subprocess, temp files and loopback sockets.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

export const REGISTRY_ORIGIN = "https://t3.registry.test";

const REGISTRY_DIR = NodePath.resolve(
  import.meta.dirname,
  "../../../../../infra/self-host/registry",
);

export interface SentRequest {
  readonly method: string;
  readonly path: string;
  readonly bodyTag: string;
  readonly contentLength: number | undefined;
  readonly bodyBytes: number;
  /** Whether the request asked for a 304 with `If-None-Match`. */
  readonly conditional: boolean;
}

export class RegistryProcess extends Context.Service<
  RegistryProcess,
  {
    readonly port: number;
    /** A fresh invite from the registry's own operator CLI. */
    readonly invite: (kind: "computer" | "phone" | "any") => string;
    /** Every request the client sent, in order. */
    readonly sent: Array<SentRequest>;
  }
>()("t3/fork/deviceKeys/registryProcess.testkit/RegistryProcess") {}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = NodeNet.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });

const startRegistry = Effect.acquireRelease(
  Effect.promise(async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3x-registry-"));
    const [api, plugin, ask] = [await freePort(), await freePort(), await freePort()];
    const env = {
      ...process.env,
      T3X_PUBLIC_ORIGIN: REGISTRY_ORIGIN,
      T3X_DB_PATH: NodePath.join(dir, "registry.db"),
      T3X_BIND_HOST: "127.0.0.1",
      T3X_API_PORT: String(api),
      T3X_PLUGIN_PORT: String(plugin),
      T3X_ASK_PORT: String(ask),
    };
    const child = NodeChildProcess.spawn(
      process.execPath,
      [NodePath.join(REGISTRY_DIR, "server.mjs")],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    const stderr: Array<string> = [];
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    await new Promise<void>((resolve, reject) => {
      let buffered = "";
      child.once("exit", (code) =>
        reject(new Error(`registry exited ${code}: ${stderr.join("")}`)),
      );
      child.stdout.on("data", (chunk) => {
        buffered += String(chunk);
        if (buffered.includes('"event":"listening"')) resolve();
      });
    });
    return { child, dir, env, port: api };
  }),
  ({ child, dir }) =>
    Effect.sync(() => {
      child.removeAllListeners("exit");
      child.kill();
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }),
);

export const layerRegistryProcess = Layer.effect(
  RegistryProcess,
  Effect.map(startRegistry, ({ env, port }) => ({
    port,
    sent: [],
    invite: (kind) => {
      const output = NodeChildProcess.execFileSync(
        process.execPath,
        [NodePath.join(REGISTRY_DIR, "cli.mjs"), "invite", "--kind", kind, "--no-qr"],
        { env, encoding: "utf8" },
      );
      const line = output.split("\n").find((entry) => entry.startsWith("t3x1."));
      if (line === undefined) throw new Error(`no invite in: ${output}`);
      return line.trim();
    },
  })),
);

/** What the production code gets as its HttpClient: same requests, aimed at the subprocess, and recorded. */
export const layerRegistryHttp = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const registry = yield* RegistryProcess;
    const base = yield* HttpClient.HttpClient;
    return base.pipe(
      HttpClient.mapRequest((request) => {
        const url = new URL(request.url);
        registry.sent.push({
          method: request.method,
          path: `${url.pathname}${url.search}`,
          bodyTag: request.body._tag,
          contentLength:
            "contentLength" in request.body ? (request.body.contentLength ?? undefined) : undefined,
          bodyBytes: request.body._tag === "Uint8Array" ? request.body.body.length : 0,
          conditional: request.headers["if-none-match"] !== undefined,
        });
        return HttpClientRequest.setUrl(
          request,
          `http://127.0.0.1:${registry.port}${url.pathname}${url.search}`,
        );
      }),
    );
  }),
).pipe(Layer.provide(FetchHttpClient.layer));
