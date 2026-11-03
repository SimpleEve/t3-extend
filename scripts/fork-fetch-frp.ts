// @effect-diagnostics nodeBuiltinImport:off - a command-line wrapper around the shared download.
// T3 Extend: download the pinned frpc for a platform, check its SHA-256, and put it in a directory.
// The packaging script uses this to bundle frpc; `t3x devices tunnel install` does the same on a headless machine.
//   node scripts/fork-fetch-frp.ts --output-dir <dir> [--platform darwin] [--arch arm64] [--base-url <mirror>]
import * as NodeUtil from "node:util";

import { FRP_MIRROR_ENV, FRP_VERSION } from "@t3tools/shared/forkFrp";
import { checkFrpcVersion, fetchFrpc } from "@t3tools/shared/forkFrpFetch";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

const main = Effect.gen(function* () {
  const hostPlatform = yield* HostProcess.Platform;
  const hostArch = yield* HostProcess.Architecture;
  const env = yield* HostProcess.Environment;
  const { values } = NodeUtil.parseArgs({
    options: {
      "output-dir": { type: "string" },
      platform: { type: "string", default: hostPlatform },
      arch: { type: "string", default: hostArch },
      "base-url": { type: "string", default: env[FRP_MIRROR_ENV] },
    },
  });
  const outputDir = values["output-dir"];
  if (outputDir === undefined) {
    return yield* Effect.die("--output-dir is required");
  }

  const fetched = yield* Effect.promise(() =>
    fetchFrpc({
      platform: values.platform,
      arch: values.arch,
      destination: outputDir,
      baseUrl: values["base-url"],
    }),
  );
  process.stdout.write(
    `frp ${FRP_VERSION}: ${fetched.url}\nsha256 ${fetched.sha256}\n${fetched.path}\n`,
  );

  // A binary for another platform cannot be run here; the checksum is what vouches for it.
  if (values.platform === hostPlatform && values.arch === hostArch) {
    const check = yield* Effect.promise(() => checkFrpcVersion(fetched.path));
    if (!check.ok) {
      return yield* Effect.die(
        `frpc -v did not report ${FRP_VERSION}: ${check.reason} ${check.found}`,
      );
    }
    process.stdout.write(`frpc -v: ${FRP_VERSION}\n`);
  }
});

await Effect.runPromise(main);
