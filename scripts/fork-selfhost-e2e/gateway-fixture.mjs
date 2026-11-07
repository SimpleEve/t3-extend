// The service the loopback-gateway scenario starts in a computer's terminal: a page, an SSE stream
// and a WebSocket on 127.0.0.1, in plain Node. Each state change is one line on a socket the
// harness listens on (listening, sse-open, sse-closed, ws-open, ws-closed), so it waits on events.
//   node gateway-fixture.mjs <port> <notify-port>
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

const [port, notifyPort] = process.argv.slice(2).map(Number);
const notify = NodeNet.connect(notifyPort, "127.0.0.1");
notify.on("error", () => process.exit(1));
const report = (line) => notify.write(`${line}\n`);

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** One unfragmented text frame, server to client (unmasked). */
const textFrame = (text) => {
  const payload = Buffer.from(text, "utf8");
  if (payload.length > 125) throw new Error("fixture frames are small");
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
};

/** Unmasks the first complete client frame in `buffer`; null when it is not all there yet. */
const readFrame = (buffer) => {
  if (buffer.length < 2) return null;
  const length = buffer[1] & 0x7f;
  if (length > 125) throw new Error("fixture frames are small");
  const end = 6 + length;
  if (buffer.length < end) return null;
  const mask = buffer.subarray(2, 6);
  const payload = Buffer.from(buffer.subarray(6, end));
  for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  return { opcode: buffer[0] & 0x0f, payload, rest: buffer.subarray(end) };
};

const server = NodeHttp.createServer((request, response) => {
  if (request.url === "/events") {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    // Separate writes, so the receiver sees them as separate events.
    response.write("data: one\n\n");
    response.write("data: two\n\n");
    response.write("data: three\n\n");
    report("sse-open");
    response.once("close", () => report("sse-closed"));
    return;
  }
  if (request.url === "/headers") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.headers));
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(
    `<!doctype html><title>gateway fixture</title><h1 id="hello">hello from the remote computer</h1>`,
  );
});

server.on("upgrade", (request, socket) => {
  const key = request.headers["sec-websocket-key"];
  if (request.url !== "/ws" || typeof key !== "string") {
    socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    return;
  }
  const accept = NodeCrypto.createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  report("ws-open");
  let pending = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    for (let frame = readFrame(pending); frame !== null; frame = readFrame(pending)) {
      pending = frame.rest;
      if (frame.opcode === 1) socket.write(textFrame(`echo:${frame.payload.toString("utf8")}`));
      if (frame.opcode === 8) socket.end();
    }
  });
  socket.on("error", () => {});
  // An upgraded socket of Node's HTTP server is half-open: it closes only once this side ends too.
  socket.once("end", () => socket.end());
  socket.once("close", () => report("ws-closed"));
});

server.listen(port, "127.0.0.1", () => report("listening"));
