// fork: the page a refused navigation shows (research/remote-loopback-forwarding.md 7.2). The
// renderer draws its own card from the `denied` event; this page is what is there underneath, so
// it only has to be plain and in the interface language.
import { getUiLocale, translate } from "@t3tools/client-runtime/i18n";
import type { LoopbackGatewayErrorCode } from "@t3tools/shared/forkLoopbackGateway/protocol";

const reason = (code: LoopbackGatewayErrorCode): string => {
  const locale = getUiLocale();
  switch (code) {
    case "not-owned":
      return translate(
        locale,
        "This port was not started by a terminal or agent in T3 on the remote environment, or the service has detached from the terminal or agent that started it (for example, moved to the background with nohup). Start it from a T3 terminal.",
      );
    case "reserved":
      return translate(locale, "This port can't be forwarded.");
    case "debug-process":
      return translate(
        locale,
        "This service is running with debugging turned on, so it can't be forwarded.",
      );
    case "owner-changed":
      return translate(locale, "The service on this port just changed. Reload to try again.");
    case "upstream-refused":
      return translate(
        locale,
        "Nothing is listening on this port in the remote environment. Start the service, then reload.",
      );
    case "offline":
      return translate(locale, "The remote environment can't be reached.");
    case "forbidden":
      return translate(locale, "This connection is not allowed to forward ports.");
    case "unauthorized":
      return translate(locale, "Reconnecting to the remote environment...");
    case "unsupported-server":
      return translate(locale, "The remote environment's T3 version can't forward localhost.");
    case "tls-untrusted":
      return translate(
        locale,
        "This computer does not trust the remote environment's certificate.",
      );
    case "limit-reached":
    case "rate-limited":
      return translate(locale, "Too many forwarded connections. Reload to try again.");
    default:
      return translate(locale, "Forwarding failed ({code}).", { code });
  }
};

export const renderGatewayErrorPage = (input: {
  readonly code: LoopbackGatewayErrorCode;
  readonly port: number;
}): string => {
  const title = translate(getUiLocale(), "Can't forward localhost:{port}", { port: input.port });
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
    `<meta name="color-scheme" content="light dark"></head>` +
    `<body style="font:15px/1.5 system-ui,sans-serif;max-width:32em;margin:12vh auto;padding:0 1.5em">` +
    `<h1 style="font-size:1.25em">${title}</h1><p>${reason(input.code)}</p></body></html>`
  );
};
