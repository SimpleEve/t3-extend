import type {
  ApnsAlertTemplate,
  ApnsAlertTemplates,
  PushDeliveryOutcome,
  PushNotificationKind,
  PushNotificationPayload,
} from "@t3tools/contracts";
import { FORK } from "@t3tools/shared/forkIdentity";

// fork: the alert an iPhone shows. Android gets data only and formats it in its own receiver; an
// iPhone has no such code without a notification extension, so the text is finished here, from
// the templates the phone registered in its own language.

const SEPARATOR = " · ";
const detail = (status: string) => [status, "{project}", "{environment}"].join(SEPARATOR);

/** Used for any kind the phone sent no template for. */
const ENGLISH_ALERT_TEMPLATES: Record<PushNotificationKind, ApnsAlertTemplate> = {
  approval: { title: "{thread}", body: detail("Approval needed") },
  input: { title: "{thread}", body: detail("Question for you") },
  completed: { title: "{thread}", body: detail("Finished") },
  failed: { title: "{thread}", body: detail("Failed") },
  test: {
    title: `${FORK.appBaseName} test notification`,
    body: "Notifications from {environment} reach this phone.",
  },
};

const MAX_TITLE = 256;
const MAX_BODY = 512;
const clip = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

/** One pass, so a thread title that happens to contain `{project}` is not filled in again. */
export function fillAlertTemplate(
  template: string,
  values: { readonly thread: string; readonly project: string; readonly environment: string },
): string {
  return template.replace(
    /\{(thread|project|environment)\}/g,
    (_match, name: keyof typeof values) => values[name],
  );
}

export interface ApnsRequestBody {
  readonly aps: {
    readonly alert: { readonly title: string; readonly body: string };
    readonly sound: "default";
    readonly "thread-id": string;
  };
  /**
   * Expo exposes this key as the notification's `data`, which is where the phone's tap handler
   * looks for the thread, exactly as it does for the official relay's pushes.
   */
  readonly body?: {
    readonly environmentId: string;
    readonly threadId: string;
    readonly deepLink: string;
  };
}

export function buildApnsRequestBody(input: {
  readonly payload: PushNotificationPayload;
  readonly templates: ApnsAlertTemplates | undefined;
}): ApnsRequestBody {
  const { payload } = input;
  const template = input.templates?.[payload.kind] ?? ENGLISH_ALERT_TEMPLATES[payload.kind];
  const values = {
    thread: payload.threadTitle,
    project: payload.projectTitle,
    environment: payload.environmentLabel,
  };
  const hasThread = payload.threadId !== "";
  return {
    aps: {
      alert: {
        title: clip(fillAlertTemplate(template.title, values), MAX_TITLE),
        body: clip(fillAlertTemplate(template.body, values), MAX_BODY),
      },
      sound: "default",
      // Alerts of one thread stack together in the notification centre.
      "thread-id": hasThread ? `${payload.environmentId}/${payload.threadId}` : "t3-agent-alerts",
    },
    ...(hasThread
      ? {
          body: {
            environmentId: payload.environmentId,
            threadId: payload.threadId,
            deepLink: `/threads/${encodeURIComponent(payload.environmentId)}/${encodeURIComponent(payload.threadId)}`,
          },
        }
      : {}),
  };
}

/** `status` is null when no response came back at all. */
export function apnsOutcome(status: number | null, reason: string | null): PushDeliveryOutcome {
  if (status === null) return "unreachable";
  if (status === 200) return "delivered";
  // The phone no longer has the app, or the token was never valid for this host: the
  // registration cannot work again until the phone sends a new token.
  if (status === 410) return "gone";
  if (status === 400 && (reason === "BadDeviceToken" || reason === "Unregistered")) return "gone";
  return "rejected";
}
