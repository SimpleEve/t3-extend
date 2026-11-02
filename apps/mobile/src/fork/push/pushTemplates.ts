import { translatorFor, type UiLocale } from "@t3tools/client-runtime/i18n";
import { FORK } from "@t3tools/shared/forkIdentity";

// fork: the server sends data (kind, titles, ids); the phone's receiver formats it from these
// templates, which JS hands over again whenever the interface language changes. Translation
// therefore stays in the one catalog, and a push renders correctly with the JS runtime stopped.
// `{thread}`, `{project}` and `{environment}` are filled by the receiver.

const SEPARATOR = " · ";

export function buildPushTemplates(locale: UiLocale): string {
  const t = translatorFor(locale);
  const detail = (status: string) => [status, "{project}", "{environment}"].join(SEPARATOR);
  return JSON.stringify({
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
  });
}
