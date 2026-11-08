import { getUiLocale, translate } from "@t3tools/client-runtime/i18n"; // fork: i18n

export type BrowserMicrophone = Pick<MediaDeviceInfo, "deviceId" | "label">;

export async function listBrowserMicrophones(): Promise<BrowserMicrophone[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === "audioinput")
    .map(({ deviceId, label }, index) => ({
      deviceId,
      label: label || translate(getUiLocale(), "Microphone {number}", { number: index + 1 }),
    }));
}
