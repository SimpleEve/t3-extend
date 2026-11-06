import {
  AuthPreviewOperateScope,
  type PreviewAnnotationPayload,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import type { ComposerImageAttachment } from "~/composerDraftStore";
import { usePreviewAvailable } from "~/browser/previewRuntime";
import { useEnvironmentScope } from "~/state/session";

import { PreviewPanelShell, type PreviewPanelMode } from "./PreviewPanelShell";
import { PreviewView } from "./PreviewView";
import { useT } from "~/hooks/useT";
import { useUnreachablePreviewNotice } from "~/fork/loopbackGateway/useUnreachablePreviewNotice"; // fork: loopback gateway

interface Props {
  mode: PreviewPanelMode;
  threadRef: ScopedThreadRef;
  tabId?: string | null;
  configuredUrls?: ReadonlyArray<string> | undefined;
  visible: boolean;
  onSendAnnotation?: (
    annotation: PreviewAnnotationPayload,
    image: ComposerImageAttachment | null,
  ) => void;
}

export function PreviewPanel({
  mode,
  threadRef,
  tabId,
  configuredUrls,
  visible,
  onSendAnnotation,
}: Props) {
  const t = useT();
  const available = usePreviewAvailable(threadRef.environmentId);
  const canOperatePreview = useEnvironmentScope(threadRef.environmentId, AuthPreviewOperateScope);
  const unreachable = useUnreachablePreviewNotice(threadRef.environmentId); // fork: loopback gateway
  if (!canOperatePreview || !available) {
    return (
      <PreviewPanelShell mode={mode}>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="max-w-sm text-sm text-muted-foreground">
            {canOperatePreview
              ? t("Preview is only available in the T3 Extend desktop app.")
              : (unreachable /* fork: loopback gateway */ ??
                t("Pair this client again with preview access to control browser previews."))}
          </p>
        </div>
      </PreviewPanelShell>
    );
  }

  return (
    <PreviewPanelShell mode={mode}>
      <PreviewView
        threadRef={threadRef}
        {...(tabId !== undefined ? { tabId } : {})}
        configuredUrls={configuredUrls}
        visible={visible}
        {...(onSendAnnotation ? { onSendAnnotation } : {})}
      />
    </PreviewPanelShell>
  );
}
