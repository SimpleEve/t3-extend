// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - sockets and a stopwatch, outside any Effect fiber.
// The measuring half of research/remote-loopback-forwarding.md 11.1: fetching the fixture's
// 300-module graph, as a proxy for a page load, with no browser (Electron is not started here), through whichever
// path the caller gives, and a TCP relay that adds latency without touching the system's network.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

export interface Fetched {
  readonly status: number;
  readonly body: string;
}

/** Fetches `path` of the page's origin; the caller decides how it travels. */
export type FetchPath = (path: string) => Promise<Fetched>;

export interface PageLoad {
  /** Until the entry module is complete. */
  readonly firstResponseMs: number;
  /** Until the last module of the graph is complete. Not `DOMContentLoaded`: nothing is parsed or run. */
  readonly graphMs: number;
  readonly requests: number;
}

/** Browsers open six HTTP/1.1 connections to one origin. */
const BROWSER_CONNECTIONS = 6;

/**
 * Loads `/m/0.js` and every module it names, breadth first, with at most six requests in flight
 * (how a browser walks a module graph: it learns a module's imports only when it has the module).
 */
export async function loadModuleGraph(fetchPath: FetchPath): Promise<PageLoad> {
  const began = performance.now();
  const seen = new Set<string>(["/m/0.js"]);
  const queue: Array<string> = ["/m/0.js"];
  let firstResponseMs = 0;
  let inFlight = 0;
  let requests = 0;
  await new Promise<void>((resolve, reject) => {
    const pump = (): void => {
      while (inFlight < BROWSER_CONNECTIONS && queue.length > 0) {
        const path = queue.shift()!;
        inFlight += 1;
        requests += 1;
        fetchPath(path).then((response) => {
          if (response.status !== 200) {
            reject(new Error(`${path} answered ${response.status}`));
            return;
          }
          if (firstResponseMs === 0) firstResponseMs = performance.now() - began;
          for (const match of response.body.matchAll(/import "(\/m\/\d+\.js)";/gu)) {
            const child = match[1]!;
            if (!seen.has(child)) {
              seen.add(child);
              queue.push(child);
            }
          }
          inFlight -= 1;
          pump();
        }, reject);
      }
      if (inFlight === 0 && queue.length === 0) resolve();
    };
    pump();
  });
  return { firstResponseMs, graphMs: performance.now() - began, requests };
}

/** GETs over keep-alive connections (at most six) to `host:port`, as a browser's pool does. */
export function keepAliveFetcher(options: {
  readonly host: string;
  readonly port: number;
  /** Absolute-form request line and headers, for a request that goes to a proxy. */
  readonly viaProxy?: { readonly authorization: string; readonly target: string };
}): { readonly fetchPath: FetchPath; readonly close: () => void } {
  const agent = new NodeHttp.Agent({ keepAlive: true, maxSockets: BROWSER_CONNECTIONS });
  const fetchPath: FetchPath = (path) =>
    new Promise((resolve, reject) => {
      const request = NodeHttp.request(
        {
          host: options.host,
          port: options.port,
          agent,
          path: options.viaProxy === undefined ? path : `${options.viaProxy.target}${path}`,
          headers:
            options.viaProxy === undefined
              ? {}
              : {
                  Host: options.viaProxy.target.replace(/^https?:\/\//u, ""),
                  "Proxy-Authorization": options.viaProxy.authorization,
                },
        },
        (response) => {
          const chunks: Array<Buffer> = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.once("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
          response.once("error", reject);
        },
      );
      request.once("error", reject);
      request.setTimeout(30_000, () =>
        request.destroy(new Error(`${path} got no answer within 30 s`)),
      );
      request.end();
    });
  return { fetchPath, close: () => agent.destroy() };
}

export interface Stats {
  readonly n: number;
  readonly median: number;
  readonly p95: number;
}

/** Nearest-rank percentiles. */
export function stats(samples: ReadonlyArray<number>): Stats {
  const sorted = [...samples].toSorted((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
  return { n: sorted.length, median: at(0.5), p95: at(0.95) };
}

export interface LatencyRelay {
  readonly port: number;
  readonly close: () => Promise<void>;
}

/**
 * A loopback TCP relay to `targetPort` that delays every chunk by half of `rttMs` in each
 * direction, in order, and holds the first byte for one round trip as a TCP handshake would. It
 * changes nothing outside this process (no `pfctl`, no `dnctl`). TLS passes through untouched.
 */
export async function startLatencyRelay(targetPort: number, rttMs: number): Promise<LatencyRelay> {
  const oneWay = rttMs / 2;
  const sockets = new Set<NodeNet.Socket>();
  const pipeDelayed = (from: NodeNet.Socket, to: NodeNet.Socket, startAt: number): void => {
    let last = startAt;
    let pending = 0;
    let ended = false;
    const finish = () => {
      if (ended && pending === 0) to.end();
    };
    from.on("data", (chunk: Buffer) => {
      const due = Math.max(last, performance.now() + oneWay);
      last = due;
      pending += 1;
      setTimeout(
        () => {
          if (!to.destroyed) to.write(chunk);
          pending -= 1;
          finish();
        },
        Math.max(0, due - performance.now()),
      );
    });
    from.once("end", () => {
      ended = true;
      finish();
    });
  };
  const server = NodeNet.createServer((client) => {
    const upstream = NodeNet.connect(targetPort, "127.0.0.1");
    sockets.add(client).add(upstream);
    const connectedAt = performance.now();
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
    pipeDelayed(client, upstream, connectedAt + rttMs);
    pipeDelayed(upstream, client, connectedAt);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: (server.address() as NodeNet.AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

export interface AuthorizeSpan {
  readonly name: string;
  readonly durationMs: number;
}

/** Durations of the server's gateway spans from its local trace file, for the spans named `names`. */
export function readServerSpans(
  home: string,
  names: ReadonlyArray<string>,
): ReadonlyArray<AuthorizeSpan> {
  const file = NodePath.join(home, "userdata", "logs", "server.trace.ndjson");
  if (!NodeFS.existsSync(file)) return [];
  const spans: Array<AuthorizeSpan> = [];
  for (const line of NodeFS.readFileSync(file, "utf8").split("\n")) {
    if (line === "") continue;
    try {
      const record = JSON.parse(line) as {
        name?: string;
        durationMs?: number;
        startTimeUnixNano?: string;
        endTimeUnixNano?: string;
      };
      if (record.name === undefined || !names.includes(record.name)) continue;
      const durationMs =
        record.durationMs ??
        (record.startTimeUnixNano !== undefined && record.endTimeUnixNano !== undefined
          ? Number(BigInt(record.endTimeUnixNano) - BigInt(record.startTimeUnixNano)) / 1e6
          : undefined);
      if (durationMs !== undefined) spans.push({ name: record.name, durationMs });
    } catch {
      // A partial last line.
    }
  }
  return spans;
}
