import { expect, it } from "vite-plus/test";

import { ANDROID_KEYSTORE_PASSWORD_ENV, resolveStorePassword } from "./fork-android-signing.ts";

it("reads the password from the environment first and never touches the Keychain then", () => {
  const readKeychain = () => {
    throw new Error("the Keychain must not be read");
  };
  expect(resolveStorePassword({ [ANDROID_KEYSTORE_PASSWORD_ENV]: "from-env" }, readKeychain)).toBe(
    "from-env",
  );
});

it("falls back to the Keychain, which is how a local build keeps working", () => {
  expect(resolveStorePassword({}, () => "from-keychain")).toBe("from-keychain");
  expect(resolveStorePassword({ [ANDROID_KEYSTORE_PASSWORD_ENV]: "" }, () => "from-keychain")).toBe(
    "from-keychain",
  );
  expect(resolveStorePassword({}, () => undefined)).toBeUndefined();
});
