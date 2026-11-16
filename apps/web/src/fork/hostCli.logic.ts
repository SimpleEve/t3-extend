import type { ServerInstallation } from "@t3tools/contracts";
import { FORK } from "@t3tools/shared/forkIdentity";

/**
 * The command a server's CLI answers to: this app's own `t3x` on this machine, the launcher's
 * own name when the server reports one, `t3` for npm-style installs. Null when it cannot be told:
 * a remote host may run official T3 Code, whose command is `t3`.
 */
export function hostCliCommand(input: {
  readonly local?: boolean;
  readonly installation?: ServerInstallation | undefined;
}): string | null {
  if (input.local === true) return FORK.cliCommand;
  switch (input.installation?.kind) {
    case "t3-launcher":
      return (
        input.installation.launcher
          .split(/[\\/]/u)
          .pop()
          ?.replace(/\.(?:cmd|exe)$/iu, "") || null
      );
    case "npm-global":
    case "npx":
    case "pnpm-dlx":
    case "bunx":
      return "t3";
    case undefined:
      return null;
  }
}
