// fork: the small crossed-out eye that says this computer is hidden from some devices. It shows in the
// Your server list and beside this computer in the environment lists, and nowhere while it is visible to all.
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { EyeOffIcon } from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { describeVisibilityDetail, visibilityLimited } from "~/fork/deviceKeysLogic";
import { devicesSnapshot, devicesStatus } from "~/fork/deviceKeysStore";
import { useT } from "~/hooks/useT";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";

/** The icon, with `label` beside it when there is room for words; `tooltip` always says the whole thing. */
export function VisibilityMark({
  tooltip,
  label,
  className,
}: {
  readonly tooltip: string;
  readonly label?: string;
  readonly className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            {...(label === undefined ? { role: "img", "aria-label": tooltip } : {})}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground",
              className,
            )}
          />
        }
      >
        <EyeOffIcon aria-hidden className="size-3.5 shrink-0" />
        {label === undefined ? null : <span>{label}</span>}
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The mark for the environment this computer's own app is connected to. It reads the status the
 * app already holds (the global device sync keeps the stream open), so it adds no traffic, and
 * it is nothing for any other environment, in a browser, or while visible to all.
 */
export function LocalVisibilityMark({
  environmentId,
  className,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly className?: string;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  if (
    environmentId === null ||
    environmentId !== primaryEnvironmentId ||
    typeof window === "undefined" ||
    window.desktopBridge === undefined
  ) {
    return null;
  }
  return <JoinedMark environmentId={environmentId} {...(className ? { className } : {})} />;
}

function JoinedMark({
  environmentId,
  className,
}: {
  readonly environmentId: EnvironmentId;
  readonly className?: string;
}) {
  const status = Option.getOrNull(
    AsyncResult.value(useAtomValue(devicesStatus({ environmentId, input: {} }))),
  );
  // The pushed list is only open while joined; reading it before that would ask for a stream that is refused.
  if (status?.state !== "joined") return null;
  return <MarkFromSnapshot environmentId={environmentId} {...(className ? { className } : {})} />;
}

function MarkFromSnapshot({
  environmentId,
  className,
}: {
  readonly environmentId: EnvironmentId;
  readonly className?: string;
}) {
  const t = useT();
  const status = Option.getOrNull(
    AsyncResult.value(useAtomValue(devicesStatus({ environmentId, input: {} }))),
  );
  const snapshot = Option.getOrNull(
    AsyncResult.value(useAtomValue(devicesSnapshot({ environmentId, input: {} }))),
  );
  const visibility = (snapshot?.status ?? status)?.visibility;
  if (visibility === undefined || !visibilityLimited(visibility)) return null;
  return (
    <VisibilityMark
      tooltip={describeVisibilityDetail(t, visibility, snapshot?.devices ?? [])}
      {...(className ? { className } : {})}
    />
  );
}
