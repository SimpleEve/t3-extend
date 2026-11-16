// fork: where the app really is, once links are followed.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { appLocationProblem, type AppRuntime } from "./appRuntime.ts";

/** A path that cannot be resolved (it does not exist) is judged as written. */
export const appRuntimeLocationProblem = Effect.fn("fork.app_runtime.location_problem")(function* (
  runtime: AppRuntime,
) {
  const fs = yield* FileSystem.FileSystem;
  const real = (path: string) => fs.realPath(path).pipe(Effect.orElseSucceed(() => path));
  return appLocationProblem({
    appPath: yield* real(runtime.appPath),
    executable: yield* real(runtime.executable),
    asar: yield* real(`${runtime.appPath}/Contents/Resources/app.asar`),
  });
});
