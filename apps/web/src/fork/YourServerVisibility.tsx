// fork: who on your own server may see this computer and sign in to it. A row under "Your server" and
// the dialog behind it; the choice is saved on this computer through the `devices.setVisibility` RPC.
import {
  DeviceKeysError,
  type DeviceListEntry,
  type DevicesStatus,
  type DeviceVisibility,
  type DeviceVisibilityMode,
  type EnvironmentId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { EyeOffIcon, MonitorIcon, SmartphoneIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { useState } from "react";

import {
  describeDevicesError,
  describeVisibility,
  describeVisibilityDetail,
  describeVisibilityRegistry,
  describeVisibilityShort,
  shortDeviceId,
  visibilityDraftReady,
  visibilityDetailAddsToLabel,
  visibilityLimited,
  visibilityToSend,
  visibilityUnchanged,
} from "~/fork/deviceKeysLogic";
import { devicesCommands } from "~/fork/deviceKeysStore";
import { useT } from "~/hooks/useT";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Radio, RadioGroup } from "../components/ui/radio-group";
import { Spinner } from "../components/ui/spinner";
import { SettingsRow } from "../components/settings/settingsLayout";

const isDeviceKeysError = Schema.is(DeviceKeysError);

const DEFAULT_VISIBILITY: NonNullable<DevicesStatus["visibility"]> = {
  mode: "visible_to_all",
  deviceIds: [],
  registry: "unknown",
};

const isMode = (value: unknown): value is DeviceVisibilityMode =>
  value === "visible_to_all" ||
  value === "hidden_from_all" ||
  value === "hidden_from_selected" ||
  value === "visible_to_selected";

export function VisibilityRow({
  environmentId,
  status,
  devices,
}: {
  readonly environmentId: EnvironmentId;
  readonly status: DevicesStatus;
  readonly devices: ReadonlyArray<DeviceListEntry>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const visibility = status.visibility ?? DEFAULT_VISIBILITY;
  const unreadable = visibility.unreadable === true;
  const limited = visibilityLimited(visibility);
  const showDetail = !unreadable && visibilityDetailAddsToLabel(visibility, devices);
  const registryNote = unreadable ? null : describeVisibilityRegistry(t, visibility.registry);
  return (
    <>
      <SettingsRow
        id="devices-visibility"
        title={
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
            {t("Visibility")}
            <Badge variant={unreadable ? "warning" : "outline"} size="sm" data-t3x-han-text>
              {limited ? <EyeOffIcon aria-hidden /> : null}
              {describeVisibilityShort(t, visibility, devices)}
            </Badge>
          </span>
        }
        description={t(
          "Choose which devices on your server can see this computer and sign in to it.",
        )}
        status={
          unreadable || showDetail || (limited && registryNote !== null) ? (
            <span className="flex flex-col gap-1">
              {unreadable ? (
                <span className="block text-warning-foreground" role="status">
                  {describeVisibilityDetail(t, visibility, devices)}
                </span>
              ) : showDetail ? (
                <span className="block">{describeVisibility(t, visibility, devices)}</span>
              ) : null}
              {registryNote === null || visibility.mode === "visible_to_all" ? null : (
                <span className="block text-warning-foreground" role="status">
                  {registryNote}
                </span>
              )}
            </span>
          ) : null
        }
        control={
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            {t("Change")}
          </Button>
        }
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-md">
          <VisibilityForm
            environmentId={environmentId}
            visibility={visibility}
            devices={devices}
            onClose={() => setOpen(false)}
          />
        </DialogPopup>
      </Dialog>
    </>
  );
}

function VisibilityForm({
  environmentId,
  visibility,
  devices,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly visibility: NonNullable<DevicesStatus["visibility"]>;
  readonly devices: ReadonlyArray<DeviceListEntry>;
  readonly onClose: () => void;
}) {
  const t = useT();
  const setVisibility = useAtomCommand(devicesCommands.setVisibility, { reportFailure: false });
  const others = devices
    .filter((device) => !device.self)
    .toSorted(
      (a, b) =>
        Number(a.kind === "phone") - Number(b.kind === "phone") || a.name.localeCompare(b.name),
    );
  // Every saved id stays in the draft. One that is not on the list is a computer that hides from this
  // one; dropping it here would quietly stop hiding from it when the dialog is saved.
  const [draft, setDraft] = useState<DeviceVisibility>({
    mode: visibility.mode,
    deviceIds: visibility.deviceIds,
  });
  const unseen = visibility.deviceIds.filter((id) => !devices.some((device) => device.id === id));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const namesDevices =
    draft.mode === "hidden_from_selected" || draft.mode === "visible_to_selected";
  const unreadable = visibility.unreadable === true;
  const registryNote = unreadable ? null : describeVisibilityRegistry(t, visibility.registry);

  const toggle = (id: string) =>
    setDraft((current) => ({
      ...current,
      deviceIds: current.deviceIds.includes(id)
        ? current.deviceIds.filter((other) => other !== id)
        : [...current.deviceIds, id],
    }));

  const save = async () => {
    setPending(true);
    setError(null);
    const result = await setVisibility({ environmentId, input: visibilityToSend(draft) });
    setPending(false);
    if (result._tag === "Success") {
      onClose();
      return;
    }
    const cause = squashAtomCommandFailure(result);
    setError(
      isDeviceKeysError(cause)
        ? cause.reason === "invalid_input"
          ? t("Pick other devices from your server's list.")
          : describeDevicesError(t, cause)
        : t("Something went wrong. Try again."),
    );
  };

  const options: ReadonlyArray<{
    readonly mode: DeviceVisibilityMode;
    readonly title: string;
    readonly hint: string;
  }> = [
    {
      mode: "visible_to_all",
      title: t("Visible to all devices"),
      hint: t("Every device on your server can see this computer. This is the default."),
    },
    {
      mode: "hidden_from_all",
      title: t("Hidden from all devices"),
      hint: t("No device can see or sign in to this computer, including ones that join later."),
    },
    {
      mode: "hidden_from_selected",
      title: t("Hidden from selected devices"),
      hint: t("The devices you pick cannot see or sign in to it. Devices that join later can."),
    },
    {
      mode: "visible_to_selected",
      title: t("Visible only to selected devices"),
      hint: t(
        "Only the devices you pick can see or sign in to it. Devices that join later cannot.",
      ),
    },
  ];

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("Who can see this computer")}</DialogTitle>
        <DialogDescription>
          {t(
            "This only controls what other devices see. This computer still sees and uses every device on your server.",
          )}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-3">
          <RadioGroup
            aria-label={t("Who can see this computer")}
            value={draft.mode}
            onValueChange={(value) => {
              if (isMode(value)) setDraft((current) => ({ ...current, mode: value }));
            }}
          >
            {options.map((option) => (
              <label key={option.mode} className="flex cursor-pointer items-start gap-2.5">
                <Radio className="mt-0.5" value={option.mode} />
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm text-foreground">{option.title}</span>
                  <span className="text-xs text-muted-foreground">{option.hint}</span>
                </span>
              </label>
            ))}
          </RadioGroup>
          {namesDevices ? (
            others.length === 0 && unseen.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("No other devices have joined your server yet.")}
              </p>
            ) : (
              <ul
                aria-label={t("Devices")}
                className="divide-y divide-border/50 overflow-hidden rounded-lg border border-border/60 bg-background/50"
              >
                {others.map((device) => (
                  <li key={device.id}>
                    <label className="flex min-h-11 cursor-pointer items-center gap-2.5 py-1.5 pr-3 pl-3">
                      <Checkbox
                        checked={draft.deviceIds.includes(device.id)}
                        onCheckedChange={() => toggle(device.id)}
                      />
                      {device.kind === "phone" ? (
                        <SmartphoneIcon
                          aria-hidden
                          className="size-4 shrink-0 text-muted-foreground"
                        />
                      ) : (
                        <MonitorIcon
                          aria-hidden
                          className="size-4 shrink-0 text-muted-foreground"
                        />
                      )}
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm text-foreground">{device.name}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {device.kind === "phone" ? t("Phone") : t("Computer")}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
                {unseen.map((id) => (
                  <li key={id}>
                    <label className="flex min-h-11 cursor-pointer items-center gap-2.5 py-1.5 pr-3 pl-3">
                      <Checkbox
                        checked={draft.deviceIds.includes(id)}
                        onCheckedChange={() => toggle(id)}
                      />
                      <EyeOffIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm text-foreground">
                          {shortDeviceId(id)}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {t("Not on your list")}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )
          ) : null}
          {unreadable ? (
            <p className="text-xs text-warning-foreground" role="status">
              {t(
                "The saved setting could not be read. Other devices are refused until you save a new one.",
              )}
            </p>
          ) : null}
          {draft.mode === "visible_to_all" ? null : (
            <p className="text-xs text-muted-foreground">
              {t(
                "Update every computer you hide this one from. One that is still on an older version also stops this computer from connecting to it.",
              )}
            </p>
          )}
          {registryNote === null ? null : (
            <p className="text-xs text-warning-foreground" role="status">
              {registryNote}
            </p>
          )}
          {error === null ? null : <p className="text-xs text-destructive">{error}</p>}
        </div>
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button variant="outline" onClick={onClose}>
          {t("Cancel")}
        </Button>
        <Button
          disabled={
            pending || !visibilityDraftReady(draft) || visibilityUnchanged(draft, visibility)
          }
          onClick={() => void save()}
        >
          {pending ? <Spinner size="sm" /> : null}
          {t("Save")}
        </Button>
      </DialogFooter>
    </>
  );
}
