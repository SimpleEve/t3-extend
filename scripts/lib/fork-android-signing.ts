/** CI has no macOS Keychain; its workflow hands the keystore password over in this variable. */
export const ANDROID_KEYSTORE_PASSWORD_ENV = "T3EXTEND_ANDROID_KEYSTORE_PASSWORD";

/** The environment wins; the Keychain is only asked when it is unset or empty. */
export function resolveStorePassword(
  env: Readonly<Record<string, string | undefined>>,
  readKeychain: () => string | undefined,
): string | undefined {
  const fromEnv = env[ANDROID_KEYSTORE_PASSWORD_ENV];
  return fromEnv ? fromEnv : readKeychain();
}
