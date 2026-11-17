import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  decodeAntigravityKeychainValue,
  makeAntigravityCliLoginReader,
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
