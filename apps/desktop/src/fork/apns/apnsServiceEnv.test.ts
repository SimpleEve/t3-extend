import { expect, it } from "vite-plus/test";

import { apnsEnvironmentFromServiceEnv } from "./apnsServiceEnv.ts";

it("takes only the APNs key from the service's env file", () => {
  expect(
    apnsEnvironmentFromServiceEnv(
      [
        "T3CODE_LAN=false",
        "T3CODE_PORT=4000",
        "T3EXTEND_APNS_KEY_FILE=/keys/AuthKey_ABC123DEFG.p8",
        'T3EXTEND_APNS_KEY_ID="ABC123DEFG"',
        "T3EXTEND_APNS_TEAM_ID=TEAM123456",
        "",
      ].join("\n"),
    ),
  ).toEqual({
    T3EXTEND_APNS_KEY_FILE: "/keys/AuthKey_ABC123DEFG.p8",
    T3EXTEND_APNS_KEY_ID: "ABC123DEFG",
    T3EXTEND_APNS_TEAM_ID: "TEAM123456",
  });
  expect(apnsEnvironmentFromServiceEnv("T3CODE_LAN=true\n")).toEqual({});
});
