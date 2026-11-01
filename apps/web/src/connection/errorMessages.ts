import type { Translator } from "@t3tools/client-runtime/i18n";

// fork: the server and client-runtime build these errors with English text. Known tags get
// translated copy here; anything else, including text a server wrote, stays as it was.

// Fixed `detail` strings from client-runtime's connection errors and pairing onboarding.
const KNOWN_DETAILS: ReadonlySet<string> = new Set([
  "The environment credential is invalid.",
  "The environment credential does not grant the required access.",
  "The environment rejected the authentication request.",
  "The environment endpoint could not be found.",
  "The environment could not authorize the connection.",
  "The pairing details are invalid.",
  "Enter a backend URL.",
  "Pairing URL is invalid.",
  "Backend URL is invalid.",
  "Pairing URL is missing its token.",
  "Enter a pairing code.",
]);

const TAG_MESSAGES: Readonly<Record<string, string>> = {
  PrimaryEnvironmentPairingCredentialRejectedError:
    "Invalid pairing token. Check the token and try again.",
  PrimaryEnvironmentPairingCredentialRequiredError: "Enter a pairing token to continue.",
  PrimaryEnvironmentAuthSessionTimeoutError:
    "Timed out waiting for authenticated session after bootstrap.",
  RemoteBackendUrlMissingError: "Enter a backend URL.",
  RemotePairingUrlInvalidError: "Pairing URL is invalid.",
  RemoteBackendUrlInvalidError: "Backend URL is invalid.",
  RemotePairingTokenMissingError: "Pairing URL is missing its token.",
  RemotePairingCodeMissingError: "Enter a pairing code.",
};

interface TaggedLike {
  readonly _tag: string;
  readonly message?: unknown;
  readonly detail?: unknown;
  readonly reason?: unknown;
  readonly hop?: unknown;
}

function isTagged(error: unknown): error is TaggedLike {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof (error as { _tag: unknown })._tag === "string"
  );
}

/**
 * Translated copy for the connection and pairing errors people hit most, or
 * null when the error is not one of them and its own message should show.
 * Null in English too, so English keeps the error's own wording and details.
 */
function knownConnectionErrorMessage(error: unknown, t: Translator): string | null {
  const source = knownSource(error);
  if (source === null) return null;
  const translated = t(source);
  return translated === source ? null : translated;
}

function knownSource(error: unknown): string | null {
  if (!isTagged(error)) return null;
  const fixed = TAG_MESSAGES[error._tag];
  if (fixed !== undefined) return fixed;
  switch (error._tag) {
    case "ConnectionBlockedError":
    case "ConnectionTransientError": {
      if (typeof error.detail === "string" && KNOWN_DETAILS.has(error.detail)) {
        return error.detail;
      }
      // Timeout and network details carry the request URL, so translate by reason instead.
      if (error.reason === "timeout") {
        return error.hop === "tunnel"
          ? "The tunnel did not answer in time."
          : "The environment did not answer in time.";
      }
      if (error.reason === "network") {
        return error.hop === "tunnel"
          ? "This device could not reach the tunnel."
          : "This device could not reach the environment.";
      }
      return null;
    }
    case "PrimaryEnvironmentRequestError":
      return "The request to this environment failed. Try again.";
  }
  return null;
}

/** The translated message for a known error, else the error's own message, else `fallback`. */
export function connectionErrorMessage(error: unknown, t: Translator, fallback: string): string {
  const known = knownConnectionErrorMessage(error, t);
  if (known !== null) return known;
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  return fallback;
}
