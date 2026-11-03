// What DeviceTunnel makes of frpc's output: four sentences, exact reasons, everything else inert.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  classifyFrpcLine,
  describeFrpcLine,
  frpcLines,
  MAX_FRPC_LINE_BYTES,
  type FrpcLogEvent,
} from "./frpcLog.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const PREFIX = "2026-11-03 16:37:23.883 [E] [client/control.go:194] [acecc0aae91dfd0e] ";

const reasonOf = (line: Uint8Array | string): string | undefined => {
  const event = classifyFrpcLine(typeof line === "string" ? encode(line) : line);
  return event?._tag === "Rejected" ? `${event.source}:${event.reason}` : event?._tag;
};

describe("classifyFrpcLine", () => {
  it("reads each of the four sentences with each exact reason", () => {
    const sentences = [
      ["pong message contains error: ", "pong"],
      ["connect to server error: ", "login"],
      ["StartWorkConn contains error: ", "workConn"],
      ["[t3x] start error: ", "proxy"],
    ] as const;
    const reasons = [
      ["t3x:revoked", "revoked"],
      ["t3x:ticket-expired", "ticket-expired"],
      ["t3x:bad-ticket", "bad-ticket"],
      ["t3x:busy", "busy"],
      ["send Ping request to plugin error", "plugin-error"],
      ["send NewWorkConn request to plugin error", "plugin-error"],
    ] as const;
    for (const [sentence, source] of sentences) {
      for (const [reason, expected] of reasons) {
        assert.equal(reasonOf(`${PREFIX}${sentence}${reason}`), `${source}:${expected}`, reason);
      }
    }
  });

  it("treats a truncated, unknown, padded or non-UTF-8 reason as `other`", () => {
    const bytes = (...parts: Array<Uint8Array | string>) =>
      Uint8Array.from(
        parts.flatMap((part) => [...(typeof part === "string" ? encode(part) : part)]),
      );
    for (const line of [
      `${PREFIX}pong message contains error: t3x:revok`,
      `${PREFIX}pong message contains error: t3x:revoked `,
      `${PREFIX}pong message contains error: T3X:REVOKED`,
      `${PREFIX}pong message contains error: t3x:revoked\u0000`,
      `${PREFIX}pong message contains error: t3x:something-new`,
      `${PREFIX}pong message contains error: `,
      `${PREFIX}connect to server error: send Login request to plugin`,
      `${PREFIX}connect to server error: send Bogus request to plugin error`,
      `${PREFIX}[t3x] start error: t3x:revok`,
      `${PREFIX}[t3x] start error: send NewProxy request to plugin`,
      `${PREFIX}[t3x] start error: t3x:revoked and more`,
      bytes(PREFIX, "pong message contains error: t3x:revoked", Uint8Array.of(0xff)),
      bytes(PREFIX, "pong message contains error: t3x:rev", Uint8Array.of(0xc3), "oked"),
    ]) {
      assert.equal(reasonOf(line)?.endsWith(":other"), true, JSON.stringify(line));
    }
  });

  it("drops a carriage return, ignores unrelated lines, and spots the proxy coming up", () => {
    assert.equal(reasonOf(`${PREFIX}pong message contains error: t3x:busy\r`), "pong:busy");
    assert.equal(
      reasonOf("2026-11-03 [I] [proxy/proxy_manager.go:173] [t3x] start proxy success"),
      "Connected",
    );
    assert.equal(reasonOf("2026-11-03 [I] login to server success, get run id [abc]"), undefined);
    assert.equal(reasonOf(""), undefined);
  });

  it("matches whole sentences only: no header boundary, another proxy, or a longer tail is not acted on", () => {
    // A sentence quoted in the middle of something else is not frpc speaking.
    assert.equal(reasonOf(`${PREFIX}note: pong message contains error: t3x:revoked`), undefined);
    assert.equal(reasonOf(`${PREFIX}xconnect to server error: t3x:revoked`), undefined);
    // Another proxy's name is not ours.
    assert.equal(reasonOf(`${PREFIX}[other] start error: t3x:revoked`), undefined);
    assert.equal(reasonOf(`${PREFIX}[other] start proxy success`), undefined);
    // "start proxy success" has to end the line and name our proxy.
    assert.equal(reasonOf(`${PREFIX}[t3x] start proxy success`), "Connected");
    assert.equal(reasonOf(`${PREFIX}[t3x] start proxy success\r`), "Connected");
    assert.equal(reasonOf(`${PREFIX}[t3x] start proxy success, then more`), undefined);
    assert.equal(reasonOf(`${PREFIX}retry: start proxy success`), undefined);
    assert.equal(reasonOf("[t3x] start proxy success"), undefined);
  });

  it("shows only short printable text for the status line", () => {
    const event: FrpcLogEvent | undefined = classifyFrpcLine(
      encode(`${PREFIX}connect to server error: \u001b[31m${"ab ".repeat(200)}`),
    );
    assert.equal(event?._tag, "Rejected");
    if (event?._tag === "Rejected") {
      assert.equal(event.text.length, 120);
      assert.notInclude(event.text, "\u001b");
    }
  });
});

describe("redaction", () => {
  const ticket = `${"a".repeat(30)}.${"b".repeat(40)}.${"c".repeat(50)}`;

  it("blanks a ticket in the text that goes to the status line, wherever it sits", () => {
    for (const reasonText of [
      `t3x:unknown ${ticket}`,
      `${ticket} tail`,
      `x${"y".repeat(100)}${ticket}`,
      "z".repeat(60),
    ]) {
      const event = classifyFrpcLine(encode(`${PREFIX}pong message contains error: ${reasonText}`));
      assert.equal(event?._tag, "Rejected");
      if (event?._tag === "Rejected") {
        assert.equal(event.reason, "other");
        assert.notInclude(event.text, ticket);
        assert.notInclude(event.text, "bbbbbbbbbb");
        assert.include(event.text, "<redacted>");
      }
    }
  });
});

describe("describeFrpcLine", () => {
  it("blanks anything shaped like a token before the line is logged", () => {
    const ticket = `${"a".repeat(30)}.${"b".repeat(40)}.${"c".repeat(50)}`;
    const described = describeFrpcLine(encode(`${PREFIX}login with ${ticket} ok`));
    assert.include(described, "login with <redacted> ok");
    assert.notInclude(described, ticket);
  });
});

describe("frpcLines", () => {
  const collect = (chunks: ReadonlyArray<Uint8Array>) =>
    Stream.fromIterable(chunks).pipe(
      frpcLines,
      Stream.map((line) => new TextDecoder().decode(line)),
      Stream.runCollect,
      Effect.map((lines) => [...lines]),
    );

  it.effect("rejoins lines split across chunks and holds back one without a newline", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* collect([encode("one\ntw"), encode("o\r\nthr"), encode("ee\nfour")]),
        ["one", "two\r", "three"],
      );
    }),
  );

  it.effect("drops an over-long line whole and carries on with the next", () =>
    Effect.gen(function* () {
      const long = "a".repeat(MAX_FRPC_LINE_BYTES + 10);
      assert.deepEqual(
        yield* collect([
          encode(`ok\n${long.slice(0, 9000)}`),
          encode(`${long.slice(9000)}\nafter\n`),
        ]),
        ["ok", "after"],
      );
    }),
  );
});
