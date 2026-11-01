import { describe, expect, it } from "vite-plus/test";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
} from "@t3tools/client-runtime/connection";
import { loadUiCatalog, translatorFor } from "@t3tools/client-runtime/i18n";

import { connectionErrorMessage } from "./errorMessages";

await loadUiCatalog("zh-Hans");
const zh = translatorFor("zh-Hans");
const en = translatorFor("en");

describe("connectionErrorMessage", () => {
  const rejected = {
    _tag: "PrimaryEnvironmentPairingCredentialRejectedError",
    message: "Invalid pairing token. Check the token and try again.",
  };
  const timeout = new ConnectionTransientError({
    reason: "timeout",
    detail: "Remote environment endpoint https://box.example/api timed out after 10000ms.",
    hop: "tunnel",
  });
  const serverText = new ConnectionBlockedError({
    reason: "configuration",
    detail: "That address reaches Mac mini, a different machine.",
  });

  it.each([
    ["a known tag", rejected, "配对令牌无效。请检查令牌后重试。"],
    [
      "a known detail",
      new ConnectionBlockedError({
        reason: "authentication",
        detail: "The environment credential is invalid.",
      }),
      "环境凭据无效。",
    ],
    ["a timeout, by reason since its detail carries a URL", timeout, "隧道没有及时响应。"],
  ])("translates %s", (_name, error, expected) => {
    expect(connectionErrorMessage(error, zh, "fallback")).toBe(expected);
  });

  it("keeps the error's own text for unknown details and in English", () => {
    expect(connectionErrorMessage(serverText, zh, "fallback")).toBe(serverText.detail);
    expect(connectionErrorMessage(timeout, en, "fallback")).toBe(timeout.detail);
    expect(connectionErrorMessage(null, zh, "fallback")).toBe("fallback");
  });
});
