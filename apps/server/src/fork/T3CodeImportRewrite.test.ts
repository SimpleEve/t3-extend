import { assert, it } from "@effect/vitest";

import {
  clearLimitRecovery,
  detachProviderThread,
  importedProviderInstanceIds,
  makeRewriter,
  pinImportedAntigravityLogin,
  uuidFromDigest,
} from "./T3CodeImportRewrite.ts";

const OLD = "11111111-1111-4111-8111-111111111111";
const NEW = "22222222-2222-4222-8222-222222222222";

it("moves only scheduledTaskId properties of the JSON, never text that looks like one", () => {
  const rewriter = makeRewriter({
    ids: new Map(),
    taskIds: new Map([["scheduled-task:a", "scheduled-task:import-b"]]),
    sourceStateDir: "/home/me/.t3/userdata",
    targetAttachmentsDir: "/a",
    targetBrowserArtifactsDir: "/b",
  });
  const quoted = '{"scheduledTaskId":"scheduled-task:a"}';
  const document = JSON.stringify({
    scheduledTaskId: "scheduled-task:a",
    items: [{ scheduledTaskId: "scheduled-task:a", note: "scheduled-task:a" }],
    text: `a payload: ${quoted}`,
    other: { scheduledTaskIdentity: "scheduled-task:a" },
  });
  assert.equal(
    rewriter.rewrite(document),
    JSON.stringify({
      scheduledTaskId: "scheduled-task:import-b",
      items: [{ scheduledTaskId: "scheduled-task:import-b", note: "scheduled-task:a" }],
      text: `a payload: ${quoted}`,
      other: { scheduledTaskIdentity: "scheduled-task:a" },
    }),
  );
  // Not JSON, or nothing to move: the text comes back as it was.
  const prose = `see ${quoted} above`;
  assert.equal(rewriter.rewrite(prose), prose);
  const unknown = JSON.stringify({ scheduledTaskId: "scheduled-task:z" });
  assert.equal(rewriter.rewrite(unknown), unknown);
  // A string that holds a JSON document is text.
  const wrapped = JSON.stringify({ text: quoted });
  assert.equal(rewriter.rewrite(wrapped), wrapped);
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

it("pins an imported Antigravity instance to a separate sign-in unless it already chose", () => {
  assert.deepStrictEqual(
    pinImportedAntigravityLogin({ driver: "antigravity", displayName: "Work", enabled: true }),
    {
      driver: "antigravity",
      displayName: "Work",
      enabled: true,
      config: { loginSource: "profile" },
    },
  );
  assert.deepStrictEqual(
    pinImportedAntigravityLogin({
      driver: "antigravity",
      config: { loginSource: "cli", authMethod: "oauth-business" },
    }),
    { driver: "antigravity", config: { loginSource: "cli", authMethod: "oauth-business" } },
  );
  const cursor = { driver: "cursor", displayName: "Cursor" };
  assert.strictEqual(pinImportedAntigravityLogin(cursor), cursor);
});

it("reads the instances an earlier import copied from its stored summary", () => {
  const summary = JSON.stringify({
    attention: [
      { code: "provider-credential-imported", subject: "antigravity, cursor", count: 2 },
      { code: "task-runs-in-both", subject: "antigravity" },
    ],
  });
  assert.deepStrictEqual(importedProviderInstanceIds(summary), ["antigravity", "cursor"]);
  assert.deepStrictEqual(importedProviderInstanceIds(null), []);
  assert.deepStrictEqual(importedProviderInstanceIds("not json"), []);
  assert.deepStrictEqual(importedProviderInstanceIds("{}"), []);
});
