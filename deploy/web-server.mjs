import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import path from "node:path";

const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 8080);
const publicRoot = path.resolve(process.env.PUBLIC_ROOT ?? "/app/public");
const scheduler = new URL(process.env.SCHEDULER_URL ?? "http://scheduler:3100");

const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function apiPath(url = "/") {
  const stripped = url.replace(/^\/api(?=\/|\?|$)/, "");
  return stripped || "/";
}

function proxyHttp(req, res) {
  const upstream = httpRequest(
    {
      protocol: scheduler.protocol,
      hostname: scheduler.hostname,
      port: scheduler.port,
      method: req.method,
      path: apiPath(req.url),
      headers: { ...req.headers, host: scheduler.host },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end('{"error":"scheduler unavailable"}');
  });
  req.pipe(upstream);
}

function serveStatic(req, res) {
  const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  const relative = path.normalize(pathname).replace(/^[/\\]+/, "");
  let file = path.resolve(publicRoot, relative);
  if (file !== publicRoot && !file.startsWith(`${publicRoot}${path.sep}`)) {
    res.writeHead(400).end("bad path");
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!existsSync(file) || !statSync(file).isFile()) file = path.join(publicRoot, "index.html");

  const headers = {
    "content-type": mime.get(path.extname(file).toLowerCase()) ?? "application/octet-stream",
    "cache-control": path.basename(file) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  };
  res.writeHead(200, headers);
  if (req.method === "HEAD") res.end();
  else createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  if ((req.url ?? "").startsWith("/api")) proxyHttp(req, res);
  else if (req.method === "GET" || req.method === "HEAD") serveStatic(req, res);
  else res.writeHead(405).end("method not allowed");
});

server.on("upgrade", (req, socket, head) => {
  if (!(req.url ?? "").startsWith("/api")) return socket.destroy();
  const upstreamReq = httpRequest({
    protocol: scheduler.protocol,
    hostname: scheduler.hostname,
    port: scheduler.port,
    method: req.method,
    path: apiPath(req.url),
    headers: { ...req.headers, host: scheduler.host },
  });
  upstreamReq.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
    const lines = [`HTTP/1.1 ${upstreamRes.statusCode ?? 101} ${upstreamRes.statusMessage ?? "Switching Protocols"}`];
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      if (Array.isArray(value)) for (const item of value) lines.push(`${name}: ${item}`);
      else if (value !== undefined) lines.push(`${name}: ${value}`);
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    upstreamSocket.pipe(socket).pipe(upstreamSocket);
  });
  upstreamReq.on("error", () => socket.destroy());
  upstreamReq.end();
});

server.listen(port, host, () => {
  console.log(`[web] listening on http://${host}:${port}; scheduler=${scheduler.origin}`);
});
