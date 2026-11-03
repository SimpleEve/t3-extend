// fork: reading frpc's console output (design 3.7 and 3.12 D). frpc has no "login failed" line, so
// only the three sentences that carry the registry's `reject_reason` are matched, and only an exact
// reason is acted on. A truncated line, bytes that are not UTF-8, or an unknown value are `other`:
// they are logged and shown, never acted on.
import * as Stream from "effect/Stream";

export type FrpcRejectSource = "pong" | "login" | "workConn";

export type FrpcRejection =
  | "revoked"
  | "ticket-expired"
  | "bad-ticket"
  | "busy"
  /** frps could not reach the registry's plugin (`send <Op> request to plugin error`). */
  | "plugin-error"
  | "other";

export type FrpcLogEvent =
  | { readonly _tag: "Connected" }
  | {
      readonly _tag: "Rejected";
      readonly source: FrpcRejectSource;
      readonly reason: FrpcRejection;
      /** Printable ASCII only, short; for `lastError`. */
      readonly text: string;
    };

/** What DeviceTunnel does about a rejection; only an exact reason ever asks for more than `none`. */
export type FrpcAction = "refresh" | "renew" | "none";

export const actionFor = (event: FrpcLogEvent): FrpcAction => {
  if (event._tag !== "Rejected") return "none";
  switch (event.reason) {
    case "revoked":
      // Only a question to the registry; it alone decides whether this computer leaves.
      return "refresh";
    case "ticket-expired":
    case "bad-ticket":
      return "renew";
    case "busy":
    case "plugin-error":
    case "other":
      return "none";
  }
};

const SENTENCES = [
  ["pong message contains error: ", "pong"],
  ["connect to server error: ", "login"],
  ["StartWorkConn contains error: ", "workConn"],
] as const satisfies ReadonlyArray<readonly [string, FrpcRejectSource]>;

const EXACT_REASONS = new Map<string, FrpcRejection>([
  ["t3x:revoked", "revoked"],
  ["t3x:ticket-expired", "ticket-expired"],
  ["t3x:bad-ticket", "bad-ticket"],
  ["t3x:busy", "busy"],
]);

const PLUGIN_ERROR = /^send (Login|NewProxy|Ping|NewWorkConn) request to plugin error$/;
const CONNECTED = "start proxy success";

/** A longer line is dropped whole: its tail, where the reason is, cannot be trusted. */
export const MAX_FRPC_LINE_BYTES = 16 * 1024;

const strict = new TextDecoder("utf-8", { fatal: true });
const lossy = new TextDecoder("utf-8");

const printable = (value: string): string => value.replace(/[^\x20-\x7e]/g, "?").slice(0, 120);

const JWT_SHAPE = /[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g;

/** A line for the debug log: printable, short, and with anything shaped like a token blanked. */
export const describeFrpcLine = (line: Uint8Array): string =>
  lossy
    .decode(line)
    .replace(JWT_SHAPE, "<redacted>")
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, 300);

export const classifyFrpcLine = (line: Uint8Array): FrpcLogEvent | undefined => {
  let text: string;
  let clean = true;
  try {
    text = strict.decode(line);
  } catch {
    text = lossy.decode(line);
    clean = false;
  }
  if (text.includes(CONNECTED)) return { _tag: "Connected" };

  let first:
    | { readonly at: number; readonly end: number; readonly source: FrpcRejectSource }
    | undefined;
  for (const [sentence, source] of SENTENCES) {
    const at = text.indexOf(sentence);
    if (at !== -1 && (first === undefined || at < first.at)) {
      first = { at, end: at + sentence.length, source };
    }
  }
  if (first === undefined) return undefined;

  const reasonText = text.slice(first.end).replace(/\r$/, "");
  const reason: FrpcRejection = !clean
    ? "other"
    : (EXACT_REASONS.get(reasonText) ?? (PLUGIN_ERROR.test(reasonText) ? "plugin-error" : "other"));
  return { _tag: "Rejected", source: first.source, reason, text: printable(reasonText) };
};

/** Splits a byte stream on `\n`. A last line without one is not a line: it may be cut off. */
export const frpcLines = <E, R>(
  bytes: Stream.Stream<Uint8Array, E, R>,
): Stream.Stream<Uint8Array, E, R> =>
  bytes.pipe(
    Stream.mapAccum(
      (): { pending: Uint8Array; skipping: boolean } => ({
        pending: new Uint8Array(0),
        skipping: false,
      }),
      (state, chunk) => {
        const lines: Array<Uint8Array> = [];
        let { pending, skipping } = state;
        let start = 0;
        for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, start)) {
          const piece = chunk.subarray(start, index);
          start = index + 1;
          if (skipping) {
            skipping = false;
            pending = new Uint8Array(0);
            continue;
          }
          const whole = pending.length === 0 ? piece : concat(pending, piece);
          pending = new Uint8Array(0);
          if (whole.length <= MAX_FRPC_LINE_BYTES) lines.push(whole);
        }
        if (!skipping) {
          const rest = chunk.subarray(start);
          const joined = pending.length === 0 ? rest : concat(pending, rest);
          if (joined.length > MAX_FRPC_LINE_BYTES) {
            skipping = true;
            pending = new Uint8Array(0);
          } else {
            pending = joined;
          }
        }
        return [{ pending, skipping }, lines] as const;
      },
    ),
  );

const concat = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left, 0);
  joined.set(right, left.length);
  return joined;
};
