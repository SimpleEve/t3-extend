// @effect-diagnostics nodeBuiltinImport:off processEnv:off - A dependency-free step of the release workflow.
// T3 Extend: the changelog a release carries. A published tag needs a finished docs/fork/changelog/<version>.md,
// which the plan job checks before any long build starts; a test build uses that file when it exists and
// otherwise a fresh draft, so the release pipeline can be tried without writing one.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { draftChangelog } from "./fork-changelog-draft.ts";

export function changelogPath(version: string): string {
  return `docs/fork/changelog/${version}.md`;
}

export function resolveReleaseChangelog(input: {
  readonly version: string;
  readonly publish: boolean;
  /** The file's text, or undefined when it does not exist. */
  readonly file: string | undefined;
  readonly draft: () => string;
}): string {
  const path = changelogPath(input.version);
  if (input.file === undefined) {
    if (input.publish) {
      throw new Error(
        `${path} is missing. Run \`vp run fork:changelog --version ${input.version}\`, finish both languages, and commit it before tagging.`,
      );
    }
    return input.draft();
  }
  if (input.publish && input.file.includes("TODO")) {
    throw new Error(`${path} still has a TODO. Translate every item, then remove the marker.`);
  }
  for (const heading of ["## 中文", "## English"]) {
    if (input.publish && !input.file.split("\n").some((line) => line.trim() === heading)) {
      throw new Error(`${path} has no "${heading}" section.`);
    }
  }
  return input.file;
}

if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({
    options: {
      version: { type: "string" },
      publish: { type: "string" },
      out: { type: "string" },
    },
  });
  const version = values.version ?? "";
  try {
    const file = NodeFS.existsSync(NodePath.join(import.meta.dirname, "..", changelogPath(version)))
      ? NodeFS.readFileSync(
          NodePath.join(import.meta.dirname, "..", changelogPath(version)),
          "utf8",
        )
      : undefined;
    const body = resolveReleaseChangelog({
      version,
      publish: values.publish === "true",
      file,
      draft: () => draftChangelog({ version }).draft,
    });
    NodeFS.writeFileSync(values.out ?? "changelog.md", body.endsWith("\n") ? body : `${body}\n`);
    process.stdout.write(
      `Changelog for ${version}: ${file === undefined ? "drafted" : "from the file"}.\n`,
    );
  } catch (error) {
    process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
