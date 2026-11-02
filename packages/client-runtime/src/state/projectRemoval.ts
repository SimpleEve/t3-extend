import { translatorFor, type Translator } from "../i18n/store.ts"; // fork: i18n
import type { EnvironmentProject, EnvironmentThreadShell } from "./models.ts";

export function planProjectRemoval<
  Thread extends Pick<EnvironmentThreadShell, "environmentId" | "projectId">,
>(options: {
  readonly members: ReadonlyArray<
    Pick<EnvironmentProject, "id" | "environmentId" | "title" | "workspaceRoot"> & {
      readonly environmentLabel?: string | null;
    }
  >;
  readonly groupMemberCount: number;
  readonly hasOtherMembers: boolean;
  readonly displayName: string;
  readonly threads: ReadonlyArray<Thread>;
  /** The members' threads this client does not hold: older settled threads its shell left out. */
  readonly unloadedThreadCount?: number;
  readonly t?: Translator; // fork: interface language, English when omitted
}) {
  const { members, groupMemberCount, hasOtherMembers, displayName, threads } = options;
  const t = options.t ?? translatorFor("en"); // fork: interface language
  const memberKeys = new Set(members.map((member) => `${member.environmentId}:${member.id}`));
  const projectThreads = threads.filter((thread) =>
    memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
  );
  const threadCount = projectThreads.length + (options.unloadedThreadCount ?? 0);
  const isWholeGroup = members.length === groupMemberCount;
  const targetKind = hasOtherMembers || !isWholeGroup ? "checkout" : "project";
  const singleMember = members.length === 1 ? members[0]! : null;
  const targetLabel = singleMember?.title ?? displayName;
  // fork: whole sentences per target kind and plural, so translations order their own words.
  const params = { label: targetLabel, count: threadCount };
  const question =
    threadCount === 0
      ? targetKind === "checkout"
        ? t('Remove checkout "{label}"?', params)
        : t('Remove project "{label}"?', params)
      : targetKind === "checkout"
        ? threadCount === 1
          ? t('Remove checkout "{label}" and delete its {count} thread?', params)
          : t('Remove checkout "{label}" and delete its {count} threads?', params)
        : threadCount === 1
          ? t('Remove project "{label}" and delete its {count} thread?', params)
          : t('Remove project "{label}" and delete its {count} threads?', params);
  const confirmationMessage = [
    question,
    ...(singleMember
      ? [
          t("Path: {path}", { path: singleMember.workspaceRoot }),
          ...(singleMember.environmentLabel
            ? [t("Environment: {environment}", { environment: singleMember.environmentLabel })]
            : []),
        ]
      : [t("This removes {count} grouped project entries.", { count: members.length })]),
    ...(threadCount > 0
      ? [
          t(
            "Those threads and any archived threads are deleted from T3 Code. Provider sessions are kept.",
          ),
        ]
      : [t("Any archived threads are deleted from T3 Code. Provider sessions are kept.")]),
    isWholeGroup && !hasOtherMembers
      ? t("This removes only the project entries, not the files on disk.")
      : t("Other entries in this grouped project are unaffected."),
    t("This action cannot be undone."),
  ].join("\n");

  return { projectThreads, isWholeGroup, targetKind, confirmationMessage };
}
