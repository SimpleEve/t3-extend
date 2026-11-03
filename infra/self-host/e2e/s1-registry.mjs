// CLI invite -> join over HTTPS through Caddy -> list -> invite a phone -> remove. Prints what it sees.
import { Device, ORIGIN, cliInvite, decodeInviteString, enrol, say, t3x } from "./lib.mjs";

const info = await fetch(`${ORIGIN}/v1/info`);
say(`GET /v1/info -> ${info.status} ${await info.text()}`);

const inviteText = cliInvite("computer");
const invite = decodeInviteString(inviteText);
say(
  `CLI invite decoded: origin=${invite.o} registry=${invite.r} kind=${invite.k} length=${inviteText.length}`,
);

const mac = new Device("Mac", "computer");
const joined = await mac.join(inviteText);
say(`computer join -> ${joined.status} ${joined.text}`);
const again = await new Device("Late", "computer").join(inviteText);
say(`same invite again -> ${again.status} ${again.text}`);

const phoneInvite = await mac.request("POST", "/v1/invites", { json: { kind: "phone" } });
say(
  `computer creates phone invite -> ${phoneInvite.status} (${phoneInvite.json?.invite?.length} chars)`,
);
const phone = new Device("Pixel", "phone");
const phoneJoined = await phone.join(phoneInvite.json.invite);
say(`phone join -> ${phoneJoined.status} ${phoneJoined.text}`);

const asPhone = await phone.request("POST", "/v1/invites", { json: { kind: "phone" } });
say(`phone tries to create an invite -> ${asPhone.status} ${asPhone.text}`);

const listing = await phone.request("GET", "/v1/devices");
say(
  `phone lists devices -> ${listing.status}: ${listing.json.devices.map((d) => `${d.name}/${d.kind}/${d.subdomain ?? "-"}`).join(", ")} rev=${listing.json.rev}`,
);
const cached = await phone.request("GET", "/v1/devices", {
  headers: { "if-none-match": listing.headers.get("etag") },
});
say(`phone lists again with If-None-Match -> ${cached.status}`);

const removed = await mac.request("DELETE", `/v1/devices/${phone.id}`);
say(`computer removes the phone -> ${removed.status} ${removed.text}`);
const gone = await phone.request("GET", "/v1/devices");
say(`phone after removal -> ${gone.status} ${gone.text}`);

say(`./t3x devices:\n${t3x("devices").stdout}`);
const second = await enrol("Mac", "computer");
say(`another computer named Mac gets subdomain ${second.joined.subdomain}`);
