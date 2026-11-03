// Runs inside a one-off container on the compose network (s8-edge.mjs): talks to caddy:443 the way a browser on port 443 does.
const https = require("node:https");
const fs = require("node:fs");

const send = (hostname, path) =>
  new Promise((resolve) => {
    const req = https.request(
      {
        host: "caddy",
        port: 443,
        servername: hostname,
        path,
        headers: { host: hostname },
        ca: fs.readFileSync("/ca/root.crt"),
        timeout: 10000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve(`${res.statusCode} ${Buffer.concat(chunks).toString().trim().slice(0, 80)}`),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve(`error ${e.code || e.message}`));
    req.end();
  });

(async () => {
  console.log(`https://${process.argv[2]}/ -> ${await send(process.argv[2], "/")}`);
  console.log(`https://${process.argv[3]}/v1/info -> ${await send(process.argv[3], "/v1/info")}`);
})();
