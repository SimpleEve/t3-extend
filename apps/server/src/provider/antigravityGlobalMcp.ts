import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/**
 * Links the profile's MCP config and MCP OAuth tokens to the agy CLI's, which agy 1.5.15 rewrites in
 * place, so a link survives a refresh. ACP cannot finish a first MCP sign-in: it waits for a pasted code.
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
  const links = [
    {
      link: path.join(input.profileDirectory, "config", "mcp_config.json"),
      target: path.join(userGemini, "config", "mcp_config.json"),
    },
    {
      link: path.join(input.profileDirectory, "antigravity-acp", "mcp_oauth_tokens.json"),
      target: path.join(userGemini, "antigravity-cli", "mcp_oauth_tokens.json"),
    },
  ];
  for (const { link, target } of links) {
    yield* Effect.gen(function* () {
      const info = yield* fs.lstat(link).pipe(Effect.option);
      const pointsAtTarget =
        Option.isSome(info) &&
        info.value.type === "SymbolicLink" &&
        (yield* fs.readLink(link).pipe(
          Effect.map((value) => path.resolve(path.dirname(link), value) === target),
          Effect.orElseSucceed(() => false),
        ));
      if (!input.enabled) {
        if (pointsAtTarget) yield* fs.remove(link);
        return;
      }
      if (pointsAtTarget) return;
      if (Option.isSome(info)) {
        // agy 1.5.8 writes an empty mcp_config.json before any server exists.
        if (info.value.type !== "File" || info.value.size > 0n) {
          kept.push(link);
          yield* Effect.logWarning(
            "Antigravity uses global MCP servers, but this profile already has its own file. It was left as is.",
            { link },
          );
          return;
        }
        yield* fs.remove(link);
      }
      yield* fs.makeDirectory(path.dirname(link), { recursive: true, mode: 0o700 });
      yield* fs.symlink(target, link);
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Antigravity global MCP link could not be updated.", {
          link,
          target,
          error,
        }),
      ),
    );
  }
  return { kept };
});
