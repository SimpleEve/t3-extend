// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** The server T3 injects into every session; agy starts a named server from its config entry, so a global entry would replace it. */
export const T3_MCP_SERVER_NAME = "t3-code";
const COPY_RECORD = ".t3-global-mcp.json";
const CONFIG_KEY = "config/mcp_config.json";
const CONFIG_SEGMENTS = [".gemini", "config", "mcp_config.json"] as const;
const TOKEN_SEGMENTS = [".gemini", "antigravity-cli", "mcp_oauth_tokens.json"] as const;

const CopyRecord = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const decodeCopyRecord = Schema.decodeUnknownOption(CopyRecord);
const encodeCopyRecord = Schema.encodeSync(CopyRecord);
const decodeObject = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/** The global config as the profile should have it, or nothing when it names no usable servers. */
const profileConfigFrom = (text: string | undefined): string | undefined => {
  if (text === undefined) return undefined;
  const config = decodeObject(text);
  if (Option.isNone(config)) return undefined;
  const { mcpServers } = config.value;
  if (typeof mcpServers !== "object" || mcpServers === null || Array.isArray(mcpServers)) {
    return undefined;
  }
  const allowed = Object.entries(mcpServers).filter(([name]) => name !== T3_MCP_SERVER_NAME);
  return `${JSON.stringify({ ...config.value, mcpServers: Object.fromEntries(allowed) }, null, 2)}\n`;
};

const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

/** agy 1.5.8 leaves an empty mcp_config.json, and agy leaves `{}` after a sign-in fails to refresh. */
const isBlank = (text: string): boolean => {
  if (text.trim() === "") return true;
  const parsed = decodeObject(text);
  return Option.isSome(parsed) && Object.keys(parsed.value).length === 0;
};

/**
 * Lets an instance's private agy profile use the MCP servers and MCP sign-ins of the agy CLI.
 * The config is copied without T3's own names, because agy starts a server from its config entry.
 * The sign-in file is linked: agy rewrites it in place, so a link survives a refresh. ACP cannot
 * finish a first MCP sign-in, which waits for a pasted code.
 */
export const syncAntigravityGlobalMcp = Effect.fn("syncAntigravityGlobalMcp")(function* (input: {
  readonly profileDirectory: string;
  readonly userHome: string;
  readonly platform: NodeJS.Platform;
  readonly enabled: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Profile files this call left alone because they hold the profile's own content.
  const kept: string[] = [];
  if (input.platform === "win32") {
    // File links need elevation there; nothing was linked, so there is nothing to undo.
    if (input.enabled) {
      yield* Effect.logWarning("Using the global agy MCP servers is not supported on Windows.");
    }
    return { kept };
  }
  const userGemini = path.join(input.userHome, ".gemini");
  const configPath = path.join(input.profileDirectory, "config", "mcp_config.json");
  const tokenPath = path.join(input.profileDirectory, "antigravity-acp", "mcp_oauth_tokens.json");
  const tokenTarget = path.join(userGemini, "antigravity-cli", "mcp_oauth_tokens.json");
  const recordPath = path.join(input.profileDirectory, COPY_RECORD);

  const readText = (file: string) =>
    fs.readFileString(file).pipe(Effect.orElseSucceed((): string | undefined => undefined));
  // A link to any home's `.gemini` equivalent is this feature's: the home can change between runs.
  const linkInto = Effect.fn("syncAntigravityGlobalMcp.linkInto")(function* (
    file: string,
    segments: ReadonlyArray<string>,
  ) {
    const target = yield* fs.readLink(file).pipe(
      Effect.map((value) => path.resolve(path.dirname(file), value)),
      Effect.option,
    );
    return Option.map(target, (resolved) => ({
      resolved,
      ours: resolved.endsWith(`${path.sep}${path.join(...segments)}`),
    }));
  });
  const keep = (file: string) =>
    Effect.suspend(() => {
      kept.push(file);
      return Effect.logWarning(
        "Antigravity uses global MCP servers, but this profile already has its own file. It was left as is.",
        { file },
      );
    });
  const guarded = <E, R>(file: string, update: Effect.Effect<void, E, R>) =>
    update.pipe(
      Effect.catch((error) =>
        Effect.logWarning("Antigravity global MCP could not be updated.", { file, error }),
      ),
    );

  const recordText = yield* readText(recordPath);
  const copies: Record<string, string> = {
    ...Option.getOrElse(decodeCopyRecord(recordText), () => ({})),
  };

  yield* guarded(
    configPath,
    Effect.gen(function* () {
      const info = yield* fs.lstat(configPath).pipe(Effect.option);
      const current =
        Option.isSome(info) && info.value.type === "File" ? yield* readText(configPath) : undefined;
      // `ours` may be replaced or removed; `blank` only replaced, and only when asked for.
      const earlierLink =
        Option.isSome(info) && info.value.type === "SymbolicLink"
          ? yield* linkInto(configPath, CONFIG_SEGMENTS)
          : Option.none();
      const generated = profileConfigFrom(
        yield* readText(path.join(userGemini, "config", "mcp_config.json")),
      );
      // The record holds a hash; the first version held the whole copy. A copy equal to what would
      // be written now is ours even when the record is lost or stale.
      const recorded = copies[CONFIG_KEY];
      const ours =
        (Option.isSome(earlierLink) && earlierLink.value.ours) ||
        (current !== undefined &&
          (current === generated || recorded === current || recorded === sha256(current)));
      const blank = current !== undefined && isBlank(current);
      if (Option.isSome(info) && !ours && !(input.enabled && blank)) {
        delete copies[CONFIG_KEY];
        if (input.enabled && !blank) yield* keep(configPath);
        return;
      }
      const wanted = input.enabled ? generated : undefined;
      if (wanted === undefined) {
        if (ours) yield* fs.remove(configPath);
        delete copies[CONFIG_KEY];
        return;
      }
      if (current !== wanted) {
        if (Option.isSome(earlierLink)) yield* fs.remove(configPath);
        yield* fs.makeDirectory(path.dirname(configPath), { recursive: true, mode: 0o700 });
        yield* writeFileStringAtomically({ filePath: configPath, contents: wanted });
      }
      copies[CONFIG_KEY] = sha256(wanted);
    }),
  );

  yield* guarded(
    tokenPath,
    Effect.gen(function* () {
      const info = yield* fs.lstat(tokenPath).pipe(Effect.option);
      if (Option.isSome(info)) {
        if (info.value.type === "SymbolicLink") {
          const link = yield* linkInto(tokenPath, TOKEN_SEGMENTS);
          if (Option.isNone(link) || !link.value.ours) {
            if (input.enabled) yield* keep(tokenPath);
            return;
          }
          if (input.enabled && link.value.resolved === tokenTarget) return;
          yield* fs.remove(tokenPath);
        } else {
          const text = info.value.type === "File" ? yield* readText(tokenPath) : undefined;
          if (!input.enabled) return;
          if (text === undefined || !isBlank(text)) return yield* keep(tokenPath);
          yield* fs.remove(tokenPath);
        }
      }
      if (!input.enabled) return;
      yield* fs.makeDirectory(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
      yield* fs.symlink(tokenTarget, tokenPath);
    }),
  );

  const encoded = Object.keys(copies).length === 0 ? undefined : encodeCopyRecord(copies);
  if (encoded !== recordText) {
    yield* guarded(
      recordPath,
      encoded === undefined
        ? fs.remove(recordPath, { force: true })
        : fs
            .makeDirectory(input.profileDirectory, { recursive: true, mode: 0o700 })
            .pipe(
              Effect.andThen(
                writeFileStringAtomically({ filePath: recordPath, contents: encoded }),
              ),
            ),
    );
  }
  return { kept };
});
