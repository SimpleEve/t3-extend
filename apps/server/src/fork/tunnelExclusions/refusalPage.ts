// fork: what a refused tunnel answers. Clients see the tunnel as a raw TCP stream (the desktop's
// SOCKS listener, its port forwards, the phone's tunnel webview), so a refusal at the handshake
// only shows the browser's own network error. Instead the tunnel opens, and an HTTP request on it
// gets a short page that says why; anything else on it is closed.
import * as Effect from "effect/Effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

import type { TunnelRefusal, TunnelRefusalCode } from "./TunnelExclusions.ts";

const REQUEST_HEAD_LIMIT = 16 * 1024;
const REQUEST_HEAD_TIMEOUT = "5 seconds";

const COPY = {
  en: {
    title: "Can't forward localhost:{port}",
    reserved: "T3 keeps this port for itself or for debugging.",
    "debug-process":
      "A service started with debugging options such as --inspect can't be forwarded. Restart it without them.",
    unverified:
      "The environment could not check which service is on this port. Reload to try again.",
  },
  zh: {
    title: "无法转发 localhost:{port}",
    reserved: "T3 把这个端口留给自己或用于调试。",
    "debug-process": "带着 --inspect 之类调试参数的服务不能转发。去掉这些参数后重新启动即可。",
    unverified: "环境没能确认这个端口上是什么服务。重新加载再试。",
  },
} as const satisfies Record<string, Record<TunnelRefusalCode | "title", string>>;

/** The first language the request names, so the page reads like the app around it. */
export const pageLanguage = (head: string): keyof typeof COPY => {
  const header = /^accept-language:[ \t]*([^\r\n]*)/imu.exec(head)?.[1] ?? "";
  return /^\s*zh\b/iu.test(header) ? "zh" : "en";
};

const escapeHtml = (text: string) => text.replace(/[&<>"]/gu, (char) => `&#${char.charCodeAt(0)};`);

const renderRefusal = (input: {
  readonly port: number;
  readonly refusal: TunnelRefusal;
  readonly head: string;
}): string => {
  const language = pageLanguage(input.head);
  const copy = COPY[language];
  const title = escapeHtml(copy.title.replace("{port}", String(input.port)));
  const body =
    `<!doctype html><html lang="${language === "zh" ? "zh-Hans" : "en"}"><head><meta charset="utf-8">` +
    `<title>${title}</title><meta name="color-scheme" content="light dark"></head>` +
    `<body style="font:15px/1.5 system-ui,sans-serif;max-width:32em;margin:12vh auto;padding:0 1.5em">` +
    `<h1 style="font-size:1.25em">${title}</h1><p>${escapeHtml(copy[input.refusal.code])}</p></body></html>`;
  const bytes = new TextEncoder().encode(body);
  return (
    "HTTP/1.1 403 Forbidden\r\ncontent-type: text/html; charset=utf-8\r\n" +
    `content-length: ${bytes.length}\r\ncache-control: no-store\r\nconnection: close\r\n\r\n${body}`
  );
};

const HTTP_REQUEST_LINE = /^[A-Z]{3,10} \S+ HTTP\/1\.[01]\r?\n/u;

/** Opens the tunnel, answers an HTTP request with the refusal page, and closes it. */
export const serveTunnelRefusal = Effect.fn("TunnelExclusions.serveRefusal")(
  function* (port: number, refusal: TunnelRefusal) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const client = yield* request.upgrade;
    const reader = yield* client.reader;
    const writer = yield* client.writer;
    const decoder = new TextDecoder();
    let head = "";
    while (!head.includes("\r\n\r\n") && head.length < REQUEST_HEAD_LIMIT) {
      for (const chunk of yield* reader.pull) {
        head += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      }
      // A TLS hello or another protocol: nothing it can read, so it is only closed.
      if (!/^[A-Z]/u.test(head) || (head.includes("\n") && !HTTP_REQUEST_LINE.test(head))) return;
    }
    if (!HTTP_REQUEST_LINE.test(head)) return;
    yield* writer.write(new TextEncoder().encode(renderRefusal({ port, refusal, head })));
  },
  (effect) =>
    effect.pipe(
      Effect.timeoutOption(REQUEST_HEAD_TIMEOUT),
      Effect.ignoreCause,
      Effect.scoped,
      Effect.as(HttpServerResponse.empty()),
    ),
);
