import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import {
  decodeAntigravityKeychainValue,
  makeAntigravityCliLoginReader,
  makeSharedAntigravityCliLoginRead,
  type AntigravityCliLoginRead,
} from "./antigravityCliLogin.ts";

const value = (token: Record<string, unknown>) =>
  JSON.stringify({ token: { token_type: "Bearer", expires_in: 3599, ...token }, auth_method: "x" });
const stored = (json: string) => `go-keyring-base64:${Buffer.from(json).toString("base64")}`;
const validToken = {
  access_token: "access-fake",
  refresh_token: "refresh-fake",
  expiry: "2026-11-17T09:30:00.123456+08:00",
};

describe("agy CLI keychain value", () => {
  it("decodes the go-keyring base64 form and plain JSON", () => {
    const expected = {
      accessToken: "access-fake",
      refreshToken: "refresh-fake",
      expiresAt: Date.parse("2026-11-17T01:30:00.123Z"),
    };
    expect(decodeAntigravityKeychainValue(`${stored(value(validToken))}\n`)).toEqual(expected);
    expect(decodeAntigravityKeychainValue(value(validToken))).toEqual(expected);
  });

  it("keeps an access token without a refresh token and refuses anything it cannot place", () => {
    expect(
      decodeAntigravityKeychainValue(value({ ...validToken, refresh_token: undefined }))
        ?.refreshToken,
    ).toBeUndefined();
    for (const bad of [
      value({ ...validToken, expiry: undefined }),
      value({ ...validToken, expiry: "soon" }),
      value({ ...validToken, access_token: "" }),
      JSON.stringify({ not: "a login" }),
      "go-keyring-base64:@@@",
      "not json",
      "",
    ]) {
      expect(decodeAntigravityKeychainValue(bad)).toBeUndefined();
    }
  });
});

describe("agy CLI keychain reader", () => {
  const spawnerReturning = (exitCode: number, stdout: string) => {
    const commands: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const standard = command as unknown as { command: string; args: ReadonlyArray<string> };
        commands.push({ command: standard.command, args: standard.args });
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.encodeText(Stream.make(stdout)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
    return { spawner, commands };
  };
  const read = (platform: NodeJS.Platform, exitCode: number, stdout: string) => {
    const { spawner, commands } = spawnerReturning(exitCode, stdout);
    const reader = makeAntigravityCliLoginReader({ platform, spawner });
    return { reader, commands };
  };

  it.effect("only reads the macOS login keychain, read-only", () =>
    Effect.gen(function* () {
      expect(read("linux", 0, "").reader).toBeUndefined();
      expect(read("win32", 0, "").reader).toBeUndefined();
      const { reader, commands } = read("darwin", 0, stored(value(validToken)));
      const outcome = yield* reader!;
      expect(outcome._tag).toBe("found");
      expect(commands).toEqual([
        {
          command: "/usr/bin/security",
          args: ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"],
        },
      ]);
    }),
  );

  it.effect("tells a missing item from a refused or unreadable one", () =>
    Effect.gen(function* () {
      expect((yield* read("darwin", 44, "").reader!)._tag).toBe("missing");
      expect((yield* read("darwin", 36, "").reader!)._tag).toBe("unreadable");
      expect((yield* read("darwin", 128, "").reader!)._tag).toBe("unreadable");
      expect((yield* read("darwin", 0, "garbage").reader!)._tag).toBe("unreadable");
    }),
  );
});

describe("shared agy CLI keychain read", () => {
  const HOUR = 60 * 60_000;
  const found = (expiresAt: number, refreshToken = "refresh-a"): AntigravityCliLoginRead => ({
    _tag: "found",
    login: { accessToken: "access-fake", refreshToken, expiresAt },
  });
  /** A reader that answers what `answers` returns now, counting how often it is asked. */
  const counting = (answers: () => AntigravityCliLoginRead) => {
    const reads = { count: 0 };
    return {
      reads,
      read: Effect.sync(() => {
        reads.count += 1;
        return answers();
      }),
    };
  };

  it.effect("makes concurrent callers wait on one read", () =>
    Effect.gen(function* () {
      const share = makeSharedAntigravityCliLoginRead();
      const started = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const reads = { count: 0 };
      const read = Effect.gen(function* () {
        reads.count += 1;
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(gate);
        return found(HOUR);
      });
      const callers = yield* Effect.forkChild(
        Effect.all([share(read), share(read), share(read)], { concurrency: "unbounded" }),
      );
      yield* Deferred.await(started);
      yield* Deferred.succeed(gate, undefined);
      const answers = yield* Fiber.join(callers);
      expect(reads.count).toBe(1);
      expect(answers.map((answer) => answer._tag)).toEqual(["found", "found", "found"]);
    }),
  );

  it.effect("reuses a good answer briefly, then notices a changed sign-in", () =>
    Effect.gen(function* () {
      const share = makeSharedAntigravityCliLoginRead();
      let refreshToken = "refresh-a";
      const { read, reads } = counting(() => found(HOUR, refreshToken));
      yield* share(read);
      yield* TestClock.adjust(29_000);
      yield* share(read);
      expect(reads.count).toBe(1);
      refreshToken = "refresh-b";
      yield* TestClock.adjust(2_000);
      const next = yield* share(read);
      expect(reads.count).toBe(2);
      expect(next._tag === "found" && next.login.refreshToken).toBe("refresh-b");
    }),
  );

  it.effect("never reuses a token past the moment it counts as expired", () =>
    Effect.gen(function* () {
      const share = makeSharedAntigravityCliLoginRead();
      // 70 seconds left, of which 10 are usable before the 60-second margin.
      const { read, reads } = counting(() => found(70_000));
      yield* share(read);
      yield* TestClock.adjust(9_000);
      yield* share(read);
      expect(reads.count).toBe(1);
      yield* TestClock.adjust(2_000);
      yield* share(read);
      expect(reads.count).toBe(2);
    }),
  );

  it.effect(
    "asks again only after two minutes once the keychain refused or the token expired",
    () =>
      Effect.gen(function* () {
        for (const failing of [
          { _tag: "unreadable" } as const,
          found(1_000), // already expired
        ]) {
          const share = makeSharedAntigravityCliLoginRead();
          let answer: AntigravityCliLoginRead = failing;
          const { read, reads } = counting(() => answer);
          yield* share(read);
          yield* TestClock.adjust(119_000);
          yield* share(read);
          expect(reads.count).toBe(1);
          // agy renewed its token meanwhile; it is picked up as soon as the wait is over.
          answer = found(HOUR * 2);
          yield* TestClock.adjust(2_000);
          expect((yield* share(read))._tag).toBe("found");
          expect(reads.count).toBe(2);
        }
      }),
  );

  it.effect("answers a read that was interrupted as unreadable and does not keep it", () =>
    Effect.gen(function* () {
      const share = makeSharedAntigravityCliLoginRead();
      const started = yield* Deferred.make<void>();
      const hung = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.as(found(HOUR)),
      );
      // The leader is cut off by its own timeout while a second caller waits on it.
      const leader = yield* Effect.forkChild(share(hung).pipe(Effect.timeoutOption("10 seconds")));
      yield* Deferred.await(started);
      // Were this caller to read for itself it would find a sign-in, so "unreadable" proves it waited.
      const waiter = yield* Effect.forkChild(share(Effect.succeed(found(HOUR))));
      yield* TestClock.adjust(10_000);
      yield* Fiber.join(leader);
      expect((yield* Fiber.join(waiter))._tag).toBe("unreadable");
      const { read, reads } = counting(() => found(HOUR));
      expect((yield* share(read))._tag).toBe("found");
      expect(reads.count).toBe(1);
    }),
  );
});
