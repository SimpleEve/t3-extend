import { assert, it } from "@effect/vitest";

import {
  clearLimitRecovery,
  detachProviderThread,
  makeRewriter,
  uuidFromDigest,
} from "./T3CodeImportRewrite.ts";

const OLD = "11111111-1111-4111-8111-111111111111";
const NEW = "22222222-2222-4222-8222-222222222222";

it("moves only the scheduledTaskId field to the task's imported id, escaped or not", () => {
  const rewriter = makeRewriter({
    ids: new Map(),
    taskIds: new Map([["scheduled-task:a", "scheduled-task:import-b"]]),
    sourceStateDir: "/home/me/.t3/userdata",
    targetAttachmentsDir: "/a",
    targetBrowserArtifactsDir: "/b",
  });
  const plain = JSON.stringify({
    scheduledTaskId: "scheduled-task:a",
    text: "see scheduled-task:a",
  });
  assert.equal(
    rewriter.rewrite(plain),
    JSON.stringify({ scheduledTaskId: "scheduled-task:import-b", text: "see scheduled-task:a" }),
  );
  const nested = JSON.stringify({ inner: plain });
  assert.include(rewriter.rewrite(nested), 'scheduledTaskId\\":\\"scheduled-task:import-b');
  const unknown = JSON.stringify({ scheduledTaskId: "scheduled-task:z" });
  assert.equal(rewriter.rewrite(unknown), unknown);
});

it("renames ids everywhere in a row and moves official folders to this environment's", () => {
  const rewriter = makeRewriter({
    ids: new Map([[OLD, NEW]]),
    sourceStateDir: "/home/me/.t3/userdata",
    targetAttachmentsDir: "/home/me/.t3extend/userdata/attachments",
    targetBrowserArtifactsDir: "/home/me/.t3extend/userdata/browser-artifacts",
  });
  const text = JSON.stringify({
    scope: `checkpoint-scope:thread:${OLD}:name:root`,
    shot: "/home/me/.t3/userdata/browser-artifacts/shot-1.png",
    other: "00000000-0000-4000-8000-000000000000",
  });
  const out = rewriter.rewrite(text);
  assert.include(out, `checkpoint-scope:thread:${NEW}:name:root`);
  assert.include(out, "/home/me/.t3extend/userdata/browser-artifacts/shot-1.png");
  assert.include(out, "00000000-0000-4000-8000-000000000000");
  assert.notInclude(out, OLD);
  assert.deepStrictEqual(rewriter.referencedFiles(), [
    { kind: "browser-artifacts", name: "shot-1.png" },
  ]);
  assert.equal(rewriter.rewrittenPathCount(), 1);
});

it("derives the same id from the same digest and clears only what would act on its own", () => {
  const digest = Uint8Array.from({ length: 32 }, (_, index) => index);
  assert.equal(uuidFromDigest(digest), uuidFromDigest(digest));
  assert.match(
    uuidFromDigest(digest),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.deepStrictEqual(clearLimitRecovery('{"limitRecovery":{"autoResume":true},"a":1}'), {
    json: '{"limitRecovery":null,"a":1}',
    cleared: true,
  });
  assert.equal(clearLimitRecovery('{"a":1}').cleared, false);
  assert.deepStrictEqual(
    JSON.parse(
      detachProviderThread(
        '{"status":"active","providerSessionId":"s","pendingBackgroundTasks":[{}],"nativeThreadRef":{"nativeId":"n"}}',
      ).json,
    ),
    {
      status: "idle",
      providerSessionId: null,
      pendingBackgroundTasks: [],
      nativeThreadRef: { nativeId: "n" },
    },
  );
});
