// fork: shapes shared by the native bridge, the model and the UI (no native imports).

export interface UnifiedPushDistributor {
  readonly id: string;
  readonly label: string;
}

export interface UnifiedPushNativeState {
  readonly enabled: boolean;
  readonly distributors: ReadonlyArray<UnifiedPushDistributor>;
  /** The package the user picked, if it is still installed. */
  readonly distributor: string | null;
  /** Host only: the endpoint is a credential and never reaches JS state. */
  readonly endpointHost: string | null;
  readonly hasKeys: boolean;
  readonly failure: string | null;
}

export interface UnifiedPushSubscription {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

export const NO_NATIVE_STATE: UnifiedPushNativeState = {
  enabled: false,
  distributors: [],
  distributor: null,
  endpointHost: null,
  hasKeys: false,
  failure: null,
};
