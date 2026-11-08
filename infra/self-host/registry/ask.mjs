// Caddy's on-demand TLS `ask` endpoint (:8082): 200 only for <registered subdomain>.<domain> and, when the push
// server is installed, ntfy.<domain>; 403 for everything else, 503 when the database errors or too many questions are in flight (Caddy treats both as no).
// `ask` cannot recall a certificate that was already issued; access control lives in the frps plugin.
// Spec: research/self-host-device-keys.md Q6 and 3.12 D.
import * as NodeHttp from "node:http";
import * as NodeURL from "node:url";

const { createServer } = NodeHttp;
const { domainToASCII } = NodeURL;

export const ASK_MAX_IN_FLIGHT = 32;

/** Test seam, like the plugin's: holds a question open so the in-flight limit can be exercised. Never set in production. */
export const askHooks = { before: null };
const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** The registered subdomain label if `name` is exactly one label under `domain`; otherwise null. */
export function subdomainOf(name, domain) {
  const ascii = domainToASCII(String(name).toLowerCase());
  const suffix = `.${domain}`;
  if (!ascii.endsWith(suffix)) return null;
  const label = ascii.slice(0, -suffix.length);
  return LABEL.test(label) ? label : null;
}

export function createAskServer({
  store,
  config,
  log = () => {},
  maxInFlight = ASK_MAX_IN_FLIGHT,
}) {
  let inFlight = 0;
  return createServer(async (req, res) => {
    const reply = (status, text) => {
      res.writeHead(status, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end(text);
    };
    if (inFlight >= maxInFlight) {
      reply(503, "busy");
      return;
    }
    inFlight += 1;
    try {
      if (askHooks.before !== null) await askHooks.before();
      const url = new URL(req.url ?? "/", "http://ask.invalid");
      if (req.method !== "GET" || url.pathname !== "/ask") {
        reply(403, "no");
        return;
      }
      const label = subdomainOf(url.searchParams.get("domain") ?? "", config.domain);
      // Every name under the domain is in the on-demand policy, ntfy's too, and "ntfy" is reserved: no computer has it.
      if (
        label === "ntfy"
          ? config.ntfyInstalled
          : label !== null && store.hasRegisteredSubdomain(label)
      ) {
        reply(200, "ok");
      } else {
        reply(403, "no");
      }
    } catch (error) {
      log({ level: "error", event: "ask_failed", message: String(error?.message ?? error) });
      reply(503, "error");
    } finally {
      inFlight -= 1;
    }
  });
}
