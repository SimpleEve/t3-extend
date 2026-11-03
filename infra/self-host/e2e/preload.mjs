// Test-only: mounted by docker-compose.test.yml, never part of the image.
// - touch /tmp/slow-login   makes the plugin's Login handler take 3 s (to see the registry answer t3x:busy at 1.5 s)
// - kill -USR2 $(cat /tmp/server.pid)   blocks the event loop forever (to see healthcheck.mjs end the container)
import * as NodeFS from "node:fs";

if (process.argv[1]?.endsWith("server.mjs")) {
  const { testHooks } = await import("/app/plugin.mjs");
  NodeFS.writeFileSync("/tmp/server.pid", String(process.pid));
  testHooks.beforeOp = async (op) => {
    if (op === "Login" && NodeFS.existsSync("/tmp/slow-login")) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  };
  process.on("SIGUSR2", () => {
    for (;;) {
      // Spin: the event loop never runs again.
    }
  });
}
