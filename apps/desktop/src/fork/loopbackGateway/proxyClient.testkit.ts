// @effect-diagnostics nodeBuiltinImport:off -- Test fixture: talks to the proxy the way Chromium does.
// fork: a client for the loopback proxy in tests: absolute-form requests with `Proxy-Authorization`.
import * as NodeHttp from "node:http";

export const proxyAuthorization = (username: string, password: string): string =>
  `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

export interface ProxyResponse {
  readonly status: number;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}

export const requestViaProxy = (
  proxyPort: number,
  authorization: string | undefined,
  target: string,
): Promise<ProxyResponse> =>
  new Promise((resolve, reject) => {
    const request = NodeHttp.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        path: target,
        agent: false,
        headers: {
          Host: target.replace(/^https?:\/\//u, "").split("/")[0],
          ...(authorization === undefined ? {} : { "Proxy-Authorization": authorization }),
        },
      },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.once("error", reject);
      },
    );
    request.once("error", reject);
    request.end();
  });
