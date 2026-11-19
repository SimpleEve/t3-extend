import type { EnvironmentId } from "@t3tools/contracts";

import { forgetApnsRegistration } from "./apnsPushRegistration";
import { forgetPushRegistration as forgetUnifiedPushRegistration } from "./unifiedPushRegistration";

// fork: whichever push this phone registered, Android's or an iPhone's, is withdrawn from an
// environment before it is removed or switched off.
export async function forgetPushRegistration(environmentId: EnvironmentId): Promise<void> {
  await Promise.all([
    forgetUnifiedPushRegistration(environmentId),
    forgetApnsRegistration(environmentId),
  ]);
}
