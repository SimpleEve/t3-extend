import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { isAntigravityTextGenerationAvailable } from "../textGeneration/AntigravityTextGeneration.ts";
import { readAntigravityProfileMcpServers } from "./acp/AntigravityAcpSupport.ts";
import { syncAntigravityGlobalMcp } from "./antigravityGlobalMcp.ts";

const servers = (value: Record<string, unknown>) => JSON.stringify({ mcpServers: value });

it.layer(NodeServices.layer)("Antigravity global MCP", (it) => {
  const fixture = Effect.fn("fixture")(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-global-mcp-" });
    const userHome = path.join(root, "home");
    const profileDirectory = path.join(root, "profile");
    const homeFiles = (home: string) => ({
      config: path.join(home, ".gemini", "config", "mcp_config.json"),
      tokens: path.join(home, ".gemini", "antigravity-cli", "mcp_oauth_tokens.json"),
    });
    const global = homeFiles(userHome);
    const own = {
      config: path.join(profileDirectory, "config", "mcp_config.json"),
      tokens: path.join(profileDirectory, "antigravity-acp", "mcp_oauth_tokens.json"),
    };
    const sync = (enabled: boolean, platform: NodeJS.Platform = "darwin", home = userHome) =>
      syncAntigravityGlobalMcp({ profileDirectory, userHome: home, platform, enabled });
    const linkValue = (file: string) =>
      fs.readLink(file).pipe(Effect.orElseSucceed((): string | undefined => undefined));
    const read = (file: string) =>
      fs.readFileString(file).pipe(Effect.orElseSucceed((): string | undefined => undefined));
    const write = Effect.fn("write")(function* (file: string, text: string) {
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, text);
    });
    const names = (text: string | undefined) =>
      Object.keys((JSON.parse(text ?? "{}") as { mcpServers?: object }).mcpServers ?? {});
    return {
      fs,
      path,
      userHome,
      profileDirectory,
      global,
      own,
      homeFiles,
      sync,
      linkValue,
      read,
      write,
      names,
    };
  });

  it.effect(
    "copies the global config without the names T3 supplies, and keeps the copy current",
    () =>
      Effect.gen(function* () {
        const { fs, global, own, sync, read, write, names } = yield* fixture();
        expect(yield* sync(true)).toEqual({ kept: [] });
        expect(yield* fs.exists(own.config)).toBe(false);

        yield* write(
          global.config,
          JSON.stringify({
            theme: "dark",
            mcpServers: {
              "t3-code": { command: "official-t3" },
              notes: { command: "notes-mcp" },
              off: { command: "off-mcp", disabled: true },
            },
          }),
        );
        expect(yield* sync(true)).toEqual({ kept: [] });
        expect(names(yield* read(own.config))).toEqual(["notes", "off"]);
        expect(JSON.parse((yield* read(own.config)) ?? "{}").theme).toBe("dark");

        yield* write(global.config, servers({ other: { command: "other-mcp" } }));
        yield* sync(true);
        expect(names(yield* read(own.config))).toEqual(["other"]);

        // The global file is gone, or not usable: the copy goes too.
        yield* write(global.config, "{ not json");
        yield* sync(true);
        expect(yield* fs.exists(own.config)).toBe(false);
        yield* write(global.config, servers({ again: { command: "again-mcp" } }));
        yield* sync(true);
        yield* fs.remove(global.config);
        yield* sync(true);
        expect(yield* fs.exists(own.config)).toBe(false);
      }),
  );

  it.effect("never overwrites or removes a config the profile owns, or one the user edited", () =>
    Effect.gen(function* () {
      const { fs, global, own, sync, read, write } = yield* fixture();
      yield* write(global.config, servers({ notes: { command: "notes-mcp" } }));
      yield* write(own.config, servers({ mine: { command: "mine-mcp" } }));

      expect(yield* sync(true)).toEqual({ kept: [own.config] });
      expect(yield* read(own.config)).toBe(servers({ mine: { command: "mine-mcp" } }));
      yield* sync(false);
      expect(yield* read(own.config)).toBe(servers({ mine: { command: "mine-mcp" } }));

      // A 0-byte file, as agy 1.5.8 writes, is replaceable.
      yield* write(own.config, "");
      expect(yield* sync(true)).toEqual({ kept: [] });
      expect(yield* read(own.config)).toContain("notes");

      // Once the copy is edited it is the user's.
      const copy = (yield* read(own.config)) ?? "";
      yield* fs.writeFileString(own.config, `${copy}\n`);
      yield* write(global.config, servers({ changed: { command: "changed-mcp" } }));
      expect(yield* sync(true)).toEqual({ kept: [own.config] });
      expect(yield* read(own.config)).toBe(`${copy}\n`);
      yield* sync(false);
      expect(yield* read(own.config)).toBe(`${copy}\n`);
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "links the MCP sign-ins, and turning off removes only what it made, from any home",
    () =>
      Effect.gen(function* () {
        const { fs, path, userHome, homeFiles, global, own, sync, linkValue, read, write } =
          yield* fixture();
        yield* write(global.config, servers({ notes: { command: "notes-mcp" } }));
        yield* write(global.tokens, '{"kept":1}');

        yield* sync(true);
        expect(yield* linkValue(own.tokens)).toBe(global.tokens);
        expect(yield* read(own.config)).toContain("notes");

        // Running again, and off then on again, change nothing else.
        yield* sync(true);
        yield* sync(false);
        expect(yield* linkValue(own.tokens)).toBeUndefined();
        expect(yield* fs.exists(own.config)).toBe(false);
        expect(yield* read(global.tokens)).toBe('{"kept":1}');
        expect(yield* read(global.config)).toBe(servers({ notes: { command: "notes-mcp" } }));
        yield* sync(true);
        expect(yield* linkValue(own.tokens)).toBe(global.tokens);

        // The home changed: the old link is replaced when on and removed when off.
        const other = homeFiles(path.join(userHome, "..", "other-home"));
        yield* sync(true, "darwin", path.join(userHome, "..", "other-home"));
        expect(yield* linkValue(own.tokens)).toBe(path.resolve(other.tokens));
        yield* sync(true);
        yield* sync(false, "darwin", path.join(userHome, "..", "third-home"));
        expect(yield* linkValue(own.tokens)).toBeUndefined();

        // A link made elsewhere is the user's.
        const elsewhere = path.join(userHome, "other.json");
        yield* fs.symlink(elsewhere, own.tokens);
        expect(yield* sync(true)).toEqual({ kept: [own.tokens] });
        yield* sync(false);
        expect(yield* linkValue(own.tokens)).toBe(elsewhere);
      }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "replaces the config link an earlier version made, and an empty sign-in file",
    () =>
      Effect.gen(function* () {
        const { fs, global, own, sync, linkValue, read, write } = yield* fixture();
        yield* write(
          global.config,
          servers({ "t3-code": { command: "x" }, notes: { command: "n" } }),
        );
        yield* fs.makeDirectory(own.config.replace("/mcp_config.json", ""), { recursive: true });
        yield* fs.symlink(global.config, own.config);

        yield* sync(true);
        expect(yield* linkValue(own.config)).toBeUndefined();
        expect(yield* read(own.config)).not.toContain("t3-code");
        expect(yield* read(own.config)).toContain("notes");

        yield* fs.remove(own.config);
        yield* fs.symlink(global.config, own.config);
        yield* sync(false);
        expect(yield* fs.exists(own.config)).toBe(false);

        // agy leaves `{}` after a failed refresh, which is not a sign-in worth keeping.
        for (const empty of ["", "  \n", "{}", "{ }"]) {
          yield* write(own.tokens, empty);
          expect(yield* sync(true)).toEqual({ kept: [] });
          expect(yield* linkValue(own.tokens)).toBe(global.tokens);
          yield* fs.remove(own.tokens);
        }
        yield* write(own.tokens, '{"http://x/mcp":{}}');
        expect(yield* sync(true)).toEqual({ kept: [own.tokens] });
      }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "names the global servers in the session and shows what it costs text generation",
    () =>
      Effect.gen(function* () {
        const { global, profileDirectory, sync, write } = yield* fixture();
        yield* sync(true);
        expect(yield* readAntigravityProfileMcpServers(profileDirectory)).toEqual([]);
        expect(yield* isAntigravityTextGenerationAvailable(profileDirectory)).toBe(true);

        yield* write(
          global.config,
          servers({ "t3-code": { command: "official" }, global: { command: "global-mcp" } }),
        );
        yield* sync(true);
        expect(yield* readAntigravityProfileMcpServers(profileDirectory)).toEqual([
          { name: "global", command: "global-mcp", args: [], env: [] },
        ]);
        expect(yield* isAntigravityTextGenerationAvailable(profileDirectory)).toBe(false);

        yield* sync(false);
        expect(yield* readAntigravityProfileMcpServers(profileDirectory)).toEqual([]);
        expect(yield* isAntigravityTextGenerationAvailable(profileDirectory)).toBe(true);
      }),
  );

  it.effect("does nothing on Windows, where file links need elevation", () =>
    Effect.gen(function* () {
      const { fs, global, own, sync, write } = yield* fixture();
      yield* write(global.config, servers({ notes: { command: "n" } }));
      expect(yield* sync(true, "win32")).toEqual({ kept: [] });
      expect(yield* fs.exists(own.config)).toBe(false);
      expect(yield* fs.exists(own.tokens)).toBe(false);
    }),
  );
});
