// A ticket that expires while frpc is connected: the next Ping must be refused with t3x:ticket-expired.
import { Frpc, enrol, frpcConfig, get, say, startOrigin, DOMAIN } from "./lib.mjs";

const { server } = await startOrigin(18707, "expiry-origin", { closeEachResponse: true });
const device = await enrol("Expiry", "computer");
const host = `${device.joined.subdomain}.${DOMAIN}`;
const exp = Math.floor(Date.now() / 1000) + 15;
const tunnel = new Frpc("expiry", (logPath) =>
  frpcConfig({
    device,
    ticket: device.ticket({ exp }),
    subdomain: device.joined.subdomain,
    localPort: 18707,
    logPath,
  }),
);
await tunnel.waitFor(/start proxy success/);
say(`ticket expires in 15 s; tunnel up, GET -> ${(await get(host)).status}`);
const refused = await tunnel.waitFor(/pong message contains error: t3x:ticket-expired/, 60_000);
say(`Ping after the expiry: ${refused === null ? "NOT refused within 60 s" : refused.match[0]}`);
await tunnel.waitFor(/connect to server error: t3x:ticket-expired/, 10_000);
say(`GET after frpc dropped -> ${(await get(host)).status}`);
say(
  tunnel
    .log()
    .split("\n")
    .filter((l) => /\[(E|W)\]/.test(l))
    .join("\n"),
);
await tunnel.stop();
server.close();
