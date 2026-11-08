// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off - a test driver around real processes and sockets.
// T3 Extend self-host end-to-end: shared helpers. Waiting is on events (process output, RPC
// snapshots); `until` is for the few states that raise none and always has a total time limit.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const say = (message: string): void => {
  process.stdout.write(`${new Date().toISOString().slice(11, 23)} ${message}\n`);
};

// @effect-diagnostics-next-line extendsNativeError:off - fork: e2e script, runs without an Effect runtime.
export class E2eFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "E2eFailure";
  }
}

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new E2eFailure(message);
}

export const checkEqual = (actual: unknown, expected: unknown, what: string): void => {
  if (actual !== expected) {
    throw new E2eFailure(
      `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
};

/**
 * Bounded retry for a state that raises no event to wait on. `reason` says why polling is the
 * only way; the total time limit is the point of the function.
 */
export async function until<T>(
  options: {
    readonly label: string;
    readonly timeoutMs: number;
    readonly reason: string;
    readonly intervalMs?: number;
  },
  probe: () => Promise<T | undefined | false> | T | undefined | false,
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined && value !== false) return value;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const cause = lastError instanceof Error ? ` (last error: ${lastError.message})` : "";
      throw new E2eFailure(
        `Timed out after ${Math.round(options.timeoutMs / 1000)} s waiting for ${options.label}${cause}.`,
      );
    }
    await sleep(options.intervalMs ?? 500);
  }
}

const LOG_MEMORY_LIMIT = 4 * 1024 * 1024;

interface LogWaiter {
  readonly pattern: RegExp;
  readonly from: number;
  readonly resolve: (match: RegExpExecArray) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/** A process's combined output: written to a file, searchable from a mark, waitable by pattern. */
export class ProcessLog {
  readonly file: string;
  #text = "";
  #dropped = 0;
  #waiters = new Set<LogWaiter>();
  #ended: string | undefined;

  constructor(file: string) {
    this.file = file;
    NodeFS.writeFileSync(file, "");
  }

  append(chunk: string): void {
    NodeFS.appendFileSync(this.file, chunk);
    this.#text += chunk;
    if (this.#text.length > LOG_MEMORY_LIMIT) {
      const cut = this.#text.length - LOG_MEMORY_LIMIT / 2;
      this.#dropped += cut;
      this.#text = this.#text.slice(cut);
    }
    for (const waiter of this.#waiters) this.#tryResolve(waiter);
  }

  /** Output from here on: pass it as `from` to wait only for lines that come later. */
  mark(): number {
    return this.#dropped + this.#text.length;
  }

  since(mark: number): string {
    return this.#text.slice(Math.max(0, mark - this.#dropped));
  }

  tail(lines = 25): string {
    return this.#text.split("\n").slice(-lines).join("\n");
  }

  /** The process is gone: nothing more will arrive, so pending waits fail now instead of at their limit. */
  end(reason: string): void {
    this.#ended = reason;
    for (const waiter of this.#waiters) {
      this.#tryResolve(waiter);
      if (this.#waiters.has(waiter)) this.#finish(waiter, new E2eFailure(reason));
    }
  }

  waitFor(
    pattern: RegExp,
    options: { readonly label: string; readonly timeoutMs: number; readonly from?: number },
  ): Promise<RegExpExecArray> {
    return new Promise((resolve, reject) => {
      const waiter: LogWaiter = {
        pattern,
        from: options.from ?? 0,
        resolve,
        reject,
        timer: setTimeout(
          () =>
            this.#finish(
              waiter,
              new E2eFailure(
                `Timed out after ${Math.round(options.timeoutMs / 1000)} s waiting for ${options.label} in ${NodePath.basename(this.file)}.`,
              ),
            ),
          options.timeoutMs,
        ),
      };
      this.#waiters.add(waiter);
      this.#tryResolve(waiter);
      if (this.#ended !== undefined && this.#waiters.has(waiter)) {
        this.#finish(waiter, new E2eFailure(this.#ended));
      }
    });
  }

  #tryResolve(waiter: LogWaiter): void {
    const match = waiter.pattern.exec(this.since(waiter.from));
    if (match !== null) {
      clearTimeout(waiter.timer);
      this.#waiters.delete(waiter);
      waiter.resolve(match);
    }
  }

  #finish(waiter: LogWaiter, error: Error): void {
    clearTimeout(waiter.timer);
    this.#waiters.delete(waiter);
    waiter.reject(error);
  }
}

/** Every process the script starts, so the end of the run stops those and nothing else. */
export class ProcessRegistry {
  readonly #children = new Map<number, NodeChildProcess.ChildProcess>();
  readonly pids = (): ReadonlyArray<number> => [...this.#children.keys()];

  spawn(
    name: string,
    command: string,
    args: ReadonlyArray<string>,
    options: NodeChildProcess.SpawnOptions & { readonly logFile: string },
  ): { readonly child: NodeChildProcess.ChildProcess; readonly log: ProcessLog } {
    const log = new ProcessLog(options.logFile);
    const child = NodeChildProcess.spawn(command, [...args], options);
    if (child.pid === undefined) throw new E2eFailure(`${name} did not start.`);
    const pid = child.pid;
    this.#children.set(pid, child);
    child.stdout?.on("data", (chunk: Buffer) => log.append(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => log.append(chunk.toString("utf8")));
    child.once("exit", (code, signal) => {
      this.#children.delete(pid);
      log.end(`${name} exited (code ${code ?? "none"}, signal ${signal ?? "none"}).`);
    });
    return { child, log };
  }

  /** TERM, then KILL after `graceMs`: only the pids this registry started. */
  async stop(pid: number, graceMs = 10_000): Promise<void> {
    const child = this.#children.get(pid);
    if (child === undefined) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
    await exited;
    clearTimeout(timer);
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.pids().map((pid) => this.stop(pid)));
  }
}

/** A clean child environment: nothing of the caller's T3 settings leaks into a test server. */
export const cleanEnv = (extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(T3CODE_|T3X_|VITE_)/u.test(key) || key === "NODE_OPTIONS") continue;
    env[key] = value;
  }
  return { ...env, ...extra };
};

export interface HttpResult {
  readonly status: number;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly text: string;
  readonly json: () => unknown;
}

/** One request, http or https by URL; https trusts whatever the process's default CAs trust. */
export function httpRequest(
  url: string,
  options: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly timeoutMs?: number;
  } = {},
): Promise<HttpResult> {
  const target = new URL(url);
  const transport = target.protocol === "https:" ? NodeHttps : NodeHttp;
  return new Promise((resolve, reject) => {
    const request = transport.request(
      target,
      {
        method: options.method ?? "GET",
        headers: {
          ...(options.body === undefined
            ? {}
            : { "content-length": String(Buffer.byteLength(options.body)) }),
          ...options.headers,
        },
        timeout: options.timeoutMs ?? 15_000,
      },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text,
            json: () => JSON.parse(text) as unknown,
          });
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error(`${url} timed out`)));
    request.on("error", reject);
    request.end(options.body);
  });
}

const canListen = (port: number, host: string): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = NodeNet.createServer();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      // A machine without IPv6 loopback cannot hold the port there either.
      resolve(error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT");
    });
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });

/** Free on both loopback addresses, which is where the stack publishes. */
export const portIsFree = async (port: number): Promise<boolean> =>
  (await canListen(port, "127.0.0.1")) && (await canListen(port, "::1"));

export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = NodeNet.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });

export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export const run = (
  command: string,
  args: ReadonlyArray<string>,
  options: NodeChildProcess.ExecFileOptions = {},
): Promise<RunResult> =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      command,
      [...args],
      { ...options, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({
          status: error === null ? 0 : typeof error.code === "number" ? error.code : null,
          stdout,
          stderr,
        }),
    );
  });
