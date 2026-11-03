import type { AdvertisedEndpoint, AdvertisedEndpointProvider } from "@t3tools/contracts";
import { createAdvertisedEndpoint } from "@t3tools/shared/advertisedEndpoint";

const SELF_HOST_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "self-host",
  label: "Public address",
  kind: "manual",
  isAddon: false,
};

const SELF_HOST_ENDPOINT_ID_PREFIX = "self-host:";

/**
 * Pairing endpoints for the public addresses the user put in front of this
 * desktop. Pairing links go straight to the address (`/pair#token=`), never
 * through the hosted web app, which a self-hosting user may not reach.
 * Addresses already listed, such as `T3CODE_DESKTOP_HTTPS_ENDPOINTS`, are skipped.
 */
export function selfHostAdvertisedEndpoints(input: {
  readonly publicUrls: ReadonlyArray<string>;
  readonly existing: ReadonlyArray<AdvertisedEndpoint>;
}): ReadonlyArray<AdvertisedEndpoint> {
  const listed = new Set(input.existing.map((endpoint) => endpoint.httpBaseUrl));
  return input.publicUrls
    .filter((httpBaseUrl) => !listed.has(httpBaseUrl))
    .map((httpBaseUrl) =>
      createAdvertisedEndpoint({
        id: `${SELF_HOST_ENDPOINT_ID_PREFIX}${httpBaseUrl}`,
        // The host keeps each address's default-preference key distinct.
        label: new URL(httpBaseUrl).host,
        provider: SELF_HOST_ENDPOINT_PROVIDER,
        httpBaseUrl,
        reachability: "public",
        source: "user",
        status: "unknown",
        description: "Public address you set up for this desktop.",
      }),
    );
}

const DEVICE_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "self-host-device",
  label: "Your server",
  kind: "manual",
  isAddon: false,
};

/**
 * This computer's own address on the server it joined, so a pairing link can reach it through
 * the tunnel. The address is the one the server wrote from its membership (the subdomain the
 * registry assigned), never a typed one. It is listed whether or not the tunnel is up, like the
 * other self-hosted addresses, with the status left unknown.
 */
export function deviceAdvertisedEndpoints(input: {
  readonly deviceUrl: string | null;
  readonly existing: ReadonlyArray<AdvertisedEndpoint>;
}): ReadonlyArray<AdvertisedEndpoint> {
  const { deviceUrl } = input;
  if (deviceUrl === null) return [];
  if (input.existing.some((endpoint) => endpoint.httpBaseUrl === deviceUrl)) return [];
  return [
    createAdvertisedEndpoint({
      id: `self-host-device:${deviceUrl}`,
      label: new URL(deviceUrl).host,
      provider: DEVICE_ENDPOINT_PROVIDER,
      httpBaseUrl: deviceUrl,
      reachability: "public",
      source: "user",
      status: "unknown",
      description: "This computer's address on your own server.",
    }),
  ];
}
