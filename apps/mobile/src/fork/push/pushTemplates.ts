import { translatorFor, type UiLocale } from "@t3tools/client-runtime/i18n";
import { FORK } from "@t3tools/shared/forkIdentity";

// fork: the server sends data (kind, titles, ids); the phone's receiver formats it from these
// templates, which JS hands over again whenever the interface language changes, so a push renders
// correctly with the JS runtime stopped. `{thread}`, `{project}` and `{environment}` are filled by
// the receiver; an iPhone registers the same set and its environment fills them in.

const SEPARATOR = " · ";

export function buildPushTemplateSet(locale: UiLocale) {
  const t = translatorFor(locale);
  const detail = (status: string) => [status, "{project}", "{environment}"].join(SEPARATOR);
  return {
    channelName: t("Agent alerts"),
    approval: { title: "{thread}", body: detail(t("Approval needed")) },
    input: { title: "{thread}", body: detail(t("Question for you")) },
    completed: { title: "{thread}", body: detail(t("Finished")) },
    failed: { title: "{thread}", body: detail(t("Failed")) },
    test: {
      title: t("{app} test notification", { app: FORK.appBaseName }),
      body: t("Notifications from {environment} reach this phone.", {
        environment: "{environment}",
      }),
    },
  };
}

export function buildPushTemplates(locale: UiLocale): string {
  return JSON.stringify(buildPushTemplateSet(locale));
}
