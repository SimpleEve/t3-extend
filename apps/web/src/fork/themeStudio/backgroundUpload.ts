import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { FORK_THEME_BACKGROUND_WS_METHODS, ThemeBackgroundUploadResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { themeEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { readPreparedConnection } from "../../state/session";
import {
  checkBackgroundFile,
  refusalOfStatus,
  type BackgroundRefusal,
} from "./backgroundUpload.logic";

// fork: sends a picture chosen in the studio to the environment that publishes themes.

export const themeBackgroundUpload = {
  createUploadUrl: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:theme-backgrounds:create-upload-url",
    tag: FORK_THEME_BACKGROUND_WS_METHODS.createUploadUrl,
  }),
};

const decodeUploadResult = Schema.decodeUnknownOption(ThemeBackgroundUploadResult);

export type BackgroundUploadOutcome =
  | { readonly ok: true; readonly hash: string }
  | { readonly ok: false; readonly reason: BackgroundRefusal; readonly detail?: string };

export async function uploadThemeBackground(file: File): Promise<BackgroundUploadOutcome> {
  const refusal = checkBackgroundFile(file);
  if (refusal !== null) return { ok: false, reason: refusal };

  const environmentId = appAtomRegistry.get(themeEnvironmentIdAtom);
  if (environmentId === null) return { ok: false, reason: "failed" };
  const minted = await runAtomCommand(
    appAtomRegistry,
    themeBackgroundUpload.createUploadUrl,
    { environmentId, input: { sizeBytes: file.size } },
    { reportFailure: false },
  );
  if (minted._tag !== "Success") return { ok: false, reason: "failed" };
  const connection = readPreparedConnection(environmentId);
  const url = connection ? resolveAssetUrl(connection.httpBaseUrl, minted.value.relativeUrl) : null;
  if (url === null) return { ok: false, reason: "failed" };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    });
    if (!response.ok) {
      const reason = refusalOfStatus(response.status);
      return reason === "full"
        ? { ok: false, reason, detail: await response.text() }
        : { ok: false, reason };
    }
    const result = decodeUploadResult(await response.json());
    return result._tag === "Some"
      ? { ok: true, hash: result.value.hash }
      : { ok: false, reason: "failed" };
  } catch {
    return { ok: false, reason: "failed" };
  }
}
