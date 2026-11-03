// Worker for the join race test: opens its own connection and tries to redeem every invite as fast as it can.
import * as NodeWorkerThreads from "node:worker_threads";

import { Store, StoreError } from "./db.mjs";
import { generateDeviceKey } from "./proof.mjs";

const { parentPort, workerData } = NodeWorkerThreads;

const { dbPath, invites, label, barrier, now } = workerData;
const store = Store.open(dbPath);
const gate = new Int32Array(barrier);
// oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker_threads port has no origin
parentPort.postMessage({ ready: true });
Atomics.wait(gate, 0, 0);

const results = [];
for (const invite of invites) {
  const device = generateDeviceKey();
  try {
    store.join({
      inviteId: invite.id,
      secret: invite.secret,
      device: { id: device.id, name: `${label} ${invite.id}`, kind: "phone", jwk: device.jwk },
      now,
    });
    results.push({ invite: invite.id, ok: true });
  } catch (error) {
    if (!(error instanceof StoreError)) throw error;
    results.push({ invite: invite.id, ok: false, code: error.code });
  }
}
store.close();
// oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker_threads port has no origin
parentPort.postMessage({ results });
