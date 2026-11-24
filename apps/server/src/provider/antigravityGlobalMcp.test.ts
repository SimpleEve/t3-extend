import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { isAntigravityTextGenerationAvailable } from "../textGeneration/AntigravityTextGeneration.ts";
import { readAntigravityProfileMcpServers } from "./acp/AntigravityAcpSupport.ts";
import { syncAntigravityGlobalMcp } from "./antigravityGlobalMcp.ts";

it.layer(NodeServices.layer)("Antigravity global MCP links", (it) => {
  const fixture = Effect.fn("fixture")(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-global-mcp-" });
    const userHome = path.join(root, "home");
    const profileDirectory = path.join(root, "profile");
    const global = {
      config: path.join(userHome, ".gemini", "config", "mcp_config.json"),
      tokens: path.join(userHome, ".gemini", "antigravity-cli", "mcp_oauth_tokens.json"),
    };
    const own = {
      config: path.join(profileDirectory, "config", "mcp_config.json"),
      tokens: path.join(profileDirectory, "antigravity-acp", "mcp_oauth_tokens.json"),
    };
    const sync = (enabled: boolean, platform: NodeJS.Platform = "darwin") =>
      syncAntigravityGlobalMcp({ profileDirectory, userHome, platform, enabled });
    const linkValue = (file: string) =>
      fs.readLink(file).pipe(Effect.orElseSucceed((): string | undefined => undefined));
    const write = Effect.fn("write")(function* (file: string, text: string) {
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, text);
    });
    return { fs, path, userHome, profileDirectory, global, own, sync, linkValue, write };
  });

  it.effect.skipIf(!symlinksSupported)(
    "points the profile's MCP config and OAuth tokens at the user's own, even before they exist",
    () =>
      Effect.gen(function* () {
        const { fs, global, own, sync, linkValue } = yield* fixture();

        expect(yield* sync(true)).toEqual({ kept: [] });
        expect(yield* linkValue(own.config)).toBe(global.config);
        expect(yield* linkValue(own.tokens)).toBe(global.tokens);
        expect(yield* fs.exists(global.config)).toBe(false);

        // Running again changes nothing.
        expect(yield* sync(true)).toEqual({ kept: [] });
        expect(yield* linkValue(own.config)).toBe(global.config);
      }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "turns off by removing only its own links, and turns on again",
    () =>
      Effect.gen(function* () {
        const { fs, path, userHome, profileDirectory, global, own, sync, linkValue, write } =
          yield* fixture();
        yield* write(global.config, '{"mcpServers":{}}');
        yield* write(global.tokens, "{}");

        yield* sync(true);
        yield* sync(false);
        expect(yield* linkValue(own.config)).toBeUndefined();
        expect(yield* linkValue(own.tokens)).toBeUndefined();
        expect(yield* fs.readFileString(global.config)).toBe('{"mcpServers":{}}');
        expect(yield* fs.readFileString(global.tokens)).toBe("{}");

        yield* sync(true);
        expect(yield* linkValue(own.config)).toBe(global.config);

        // A link the user made elsewhere is theirs; real files are never deleted.
        yield* sync(false);
        const elsewhere = path.join(userHome, "other.json");
        yield* fs.symlink(elsewhere, own.config);
        yield* write(own.tokens, '{"kept":true}');
        yield* sync(false);
        expect(yield* linkValue(own.config)).toBe(elsewhere);
        expect(yield* fs.readFileString(own.tokens)).toBe('{"kept":true}');
        expect(yield* fs.exists(profileDirectory)).toBe(true);
      }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "keeps a profile file that has content, replaces an empty one",
    () =>
      Effect.gen(function* () {
        const { fs, global, own, sync, linkValue, write } = yield* fixture();
        yield* write(own.config, '{"mcpServers":{"mine":{"command":"mine-mcp"}}}');
        // agy 1.5.8 writes a 0-byte mcp_config.json before any server exists.
        yield* write(own.tokens, "");

        expect(yield* sync(true)).toEqual({ kept: [own.config] });
        expect(yield* linkValue(own.config)).toBeUndefined();
        expect(yield* fs.readFileString(own.config)).toBe(
          '{"mcpServers":{"mine":{"command":"mine-mcp"}}}',
        );
        expect(yield* linkValue(own.tokens)).toBe(global.tokens);

        // Another link is also left alone.
        yield* fs.remove(own.tokens);
        yield* fs.symlink("/somewhere/else.json", own.tokens);
        expect(yield* sync(true)).toEqual({ kept: [own.config, own.tokens] });
        expect(yield* linkValue(own.tokens)).toBe("/somewhere/else.json");
      }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "names the global servers in the session and shows what it costs text generation",
    () =>
      Effect.gen(function* () {
        const { global, profileDirectory, sync, write } = yield* fixture();
        yield* sync(true);
        // A link to nothing is no config: nothing to name, and text generation stays available.
        expect(yield* readAntigravityProfileMcpServers(profileDirectory)).toEqual([]);
        expect(yield* isAntigravityTextGenerationAvailable(profileDirectory)).toBe(true);

        yield* write(
          global.config,
          JSON.stringify({ mcpServers: { global: { command: "global-mcp" } } }),
        );
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
      const { fs, own, sync } = yield* fixture();
      expect(yield* sync(true, "win32")).toEqual({ kept: [] });
      expect(yield* fs.exists(own.config)).toBe(false);
      expect(yield* fs.exists(own.tokens)).toBe(false);
    }),
  );
});
