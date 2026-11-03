// frpc with a ticket logs in, the vhost reaches a local origin, a foreign subdomain is refused, and client-ip headers.
import * as NodeFS from "node:fs";

import {
  EVIDENCE,
  Frpc,
  enrol,
  frpcConfig,
  get,
  recordPid,
  say,
  sleep,
  startOrigin,
} from "./lib.mjs";

const { server, seen } = await startOrigin(18700, "alpha-origin");
recordPid("origin-18700", process.pid);
const alpha = await enrol("Alpha", "computer");
const beta = await enrol("Beta", "computer");
say(`alpha subdomain=${alpha.joined.subdomain}, beta subdomain=${beta.joined.subdomain}`);

const tunnel = new Frpc("alpha", (logPath) =>
  frpcConfig({
    device: alpha,
    ticket: alpha.ticket(),
    subdomain: alpha.joined.subdomain,
    localPort: 18700,
    logPath,
  }),
);
const login = await tunnel.waitFor(/start proxy success/);
say(
  `alpha frpc: ${login === null ? "NO LOGIN" : "proxy started"}\n${tunnel
    .log()
    .split("\n")
    .filter((l) => /login|proxy/.test(l))
    .join("\n")}`,
);

const page = await get(`${alpha.joined.subdomain}.t3.localhost`);
say(`GET https://alpha.t3.localhost:18443/ -> ${page.status} ${JSON.stringify(page.text)}`);
const last = seen.at(-1).headers;
say(
  `origin saw: host=${last.host} x-forwarded-proto=${last["x-forwarded-proto"]} xff=${last["x-forwarded-for"]} x-t3x-client-ip=${last["x-t3x-client-ip"]}`,
);

const forged = await get(`${alpha.joined.subdomain}.t3.localhost`, "/forged", {
  "x-t3x-client-ip": "1.2.3.4",
});
const forgedSeen = seen.at(-1).headers;
say(
  `with a forged X-T3x-Client-IP: 1.2.3.4 -> ${forged.status}; origin saw x-t3x-client-ip=${forgedSeen["x-t3x-client-ip"]} xff=${forgedSeen["x-forwarded-for"]}`,
);
const forgedMany = await get(`${alpha.joined.subdomain}.t3.localhost`, "/forged2", {
  "x-t3x-client-ip": "1.2.3.4",
  "x-forwarded-for": "5.6.7.8",
});
say(
  `forged header + forged XFF -> origin saw x-t3x-client-ip=${seen.at(-1).headers["x-t3x-client-ip"]} xff=${seen.at(-1).headers["x-forwarded-for"]}`,
);
void forgedMany;

// The same header on the /v1 side reaches the registry, which logs/limits by it: checked in s5.
const evil = new Frpc("alpha-as-beta", (logPath) =>
  frpcConfig({
    device: alpha,
    ticket: alpha.ticket(),
    subdomain: beta.joined.subdomain,
    localPort: 18700,
    logPath,
  }),
);
await sleep(4000);
say(
  `alpha's ticket asking for beta's subdomain:\n${evil
    .log()
    .split("\n")
    .filter((l) => /login|proxy|error/i.test(l))
    .join("\n")}`,
);
const betaPage = await get(`${beta.joined.subdomain}.t3.localhost`);
say(
  `beta's subdomain afterwards -> ${betaPage.status} ${JSON.stringify(betaPage.text.slice(0, 60))}`,
);

const other = new Frpc("beta-ticket-alpha-user", (logPath) =>
  frpcConfig({
    device: alpha,
    ticket: beta.ticket(),
    subdomain: beta.joined.subdomain,
    localPort: 18700,
    logPath,
  }),
);
await sleep(3000);
say(
  `beta's ticket but alpha's user name:\n${other
    .log()
    .split("\n")
    .filter((l) => /login|proxy|error/i.test(l))
    .join("\n")}`,
);

await Promise.all([evil.stop(), other.stop()]);
NodeFS.writeFileSync(
  `${EVIDENCE}/s2-state.json`,
  JSON.stringify({ alpha: alpha.id, beta: beta.id }),
);
await tunnel.stop();
server.close();
