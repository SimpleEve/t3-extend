// fork: replace a file whole. The content goes to a uniquely named sibling first and is renamed over
// the target, so a reader (or a second process) sees the old file or the new one, never half of it,
// and two writers never share a temporary name. A failed write removes its own temporary file.
// @effect-diagnostics nodeBuiltinImport:off -- Only for a temporary file name's random suffix.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

export const writeFileAtomic = Effect.fn("writeFileAtomic")(function* (
  file: string,
  content: string,
  mode: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const suffix = NodeCrypto.randomBytes(8).toString("hex");
  const temporary = `${file}.${process.pid}.${suffix}.tmp`;
  yield* fs.writeFileString(temporary, content, { mode }).pipe(
    Effect.andThen(fs.rename(temporary, file)),
    Effect.onError(() => fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
  );
});
