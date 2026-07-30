import { DurableObject } from "cloudflare:workers";

interface Env {
  TUNNEL_DO: DurableObjectNamespace<TunnelDO>;
}

interface PendingRequest {
  resolve: (response: ProxyResponse) => void;
  reject: (err: Error) => void;
  timer: Timer;
}

interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const REQUEST_TIMEOUT = 30_000;
const SHARDS = 10;

function generateSubdomain(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

const ROOT_HOSTS = [
  "lokly.heydeyo.lol",
  "lokly.ryme.workers.dev",
];

function isRootHost(host: string): boolean {
  return ROOT_HOSTS.includes(host);
}

function extractSubdomain(host: string): string | null {
  if (host.endsWith("-lokly.heydeyo.lol")) {
    const prefix = host.slice(0, host.indexOf("-lokly.heydeyo.lol"));
    if (prefix) return prefix;
  }
  for (const root of ROOT_HOSTS) {
    const rootParts = root.split(".");
    const parts = host.split(".");
    if (parts.length === rootParts.length + 1) {
      const subdomain = parts[0];
      const rest = parts.slice(1).join(".");
      if (rest === root) return subdomain;
    }
  }
  return null;
}

function tunnelUrl(subdomain: string): string {
  return `https://${subdomain}-lokly.heydeyo.lol`;
}

function shardId(subdomain: string): number {
  return subdomain.charCodeAt(0) % SHARDS;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const host = request.headers.get("host") || "";

    if (request.headers.get("Upgrade") === "websocket") {
      return handleRegister(request, env);
    }

    if (isRootHost(host)) {
      return new Response(ROOT_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    const subdomain = extractSubdomain(host);
    if (!subdomain) {
      return new Response(`Unknown host: ${host}`, { status: 400 });
    }

    return handleProxy(request, env, subdomain);
  },
} satisfies ExportedHandler<Env>;

async function handleRegister(request: Request, env: Env): Promise<Response> {
  const subdomain = generateSubdomain();
  const doId = env.TUNNEL_DO.idFromName(`tunnel-${shardId(subdomain)}`);
  const stub = env.TUNNEL_DO.get(doId);

  const host = request.headers.get("host") || "lokly.heydeyo.lol";
  const url = new URL(request.url);
  url.searchParams.set("subdomain", subdomain);
  url.searchParams.set("host", host);
  const modified = new Request(url.toString(), request);
  return stub.fetch(modified);
}

async function handleProxy(request: Request, env: Env, subdomain: string): Promise<Response> {
  const doId = env.TUNNEL_DO.idFromName(`tunnel-${shardId(subdomain)}`);
  const stub = env.TUNNEL_DO.get(doId);
  const url = new URL(request.url);
  url.searchParams.set("x-subdomain", subdomain);
  return stub.fetch(new Request(url.toString(), request));
}

export class TunnelDO extends DurableObject<Env> {
  private subdomainToWs = new Map<string, WebSocket>();
  private pending = new Map<string, PendingRequest>();

  async fetch(request: Request): Promise<Response> {
    if (this.subdomainToWs.size === 0 && this.ctx.getWebSockets().length > 0) {
      for (const ws of this.ctx.getWebSockets()) {
        ws.send(JSON.stringify({ type: "whoami" }));
      }
    }

    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }
    return this.handleProxyRequest(request);
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const subdomain = url.searchParams.get("subdomain")!;
    const host = url.searchParams.get("host") || "lokly.heydeyo.lol";

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    this.subdomainToWs.set(subdomain, server);

    server.send(
      JSON.stringify({
        type: "registered",
        subdomain,
        url: tunnelUrl(subdomain),
      })
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleProxyRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const subdomain = url.searchParams.get("x-subdomain") || "";
    const ws = this.subdomainToWs.get(subdomain);

    if (!ws) {
      return new Response(TUNNEL_OFFLINE_HTML, {
        status: 502,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    const requestId = crypto.randomUUID();
    const body = request.body ? await request.arrayBuffer() : new ArrayBuffer(0);

    ws.send(
      JSON.stringify({
        type: "request",
        id: requestId,
        method: request.method,
        path: url.pathname + url.search,
        headers: Object.fromEntries(
          [...request.headers.entries()].filter(
            ([k]) => k.toLowerCase() !== "x-subdomain"
          )
        ),
        body: body.byteLength > 0 ? arrayBufferToBase64(body) : "",
      })
    );

    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Request timeout"));
      }, REQUEST_TIMEOUT);

      this.pending.set(requestId, {
        resolve: (proxyResp: ProxyResponse) => {
          clearTimeout(timer);
          const headers = new Headers();
          for (const [k, v] of Object.entries(proxyResp.headers)) {
            if (k.toLowerCase() !== "transfer-encoding") {
              headers.set(k, v);
            }
          }
          const decodedBody = proxyResp.body
            ? base64ToUint8Array(proxyResp.body)
            : new Uint8Array(0);
          resolve(
            new Response(decodedBody, {
              status: proxyResp.status,
              headers,
            })
          );
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
        timer,
      });
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;

    let data: any;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    if (data.type === "register" && data.subdomain) {
      this.subdomainToWs.set(data.subdomain, ws);
      return;
    }

    if (data.type === "response" && data.id) {
      const pending = this.pending.get(data.id);
      if (pending) {
        this.pending.delete(data.id);
        pending.resolve({
          status: data.status || 200,
          headers: data.headers || {},
          body: data.body || "",
        });
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    for (const [sd, w] of this.subdomainToWs) {
      if (w === ws) {
        this.subdomainToWs.delete(sd);
        break;
      }
    }
    for (const [id, pending] of this.pending) {
      pending.reject(new Error("Tunnel closed"));
    }
    this.pending.clear();
  }
}

const ROOT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>lokly</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: "SF Mono", "Fira Code", "Courier New", monospace;
      background: #000;
      color: #fff;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 2rem;
    }
    .container {
      max-width: 600px;
      width: 100%;
    }
    .header {
      border-bottom: 1px solid #333;
      padding-bottom: 1.5rem;
      margin-bottom: 2rem;
    }
    .header h1 {
      font-size: 1rem;
      font-weight: 400;
      color: #555;
      text-transform: uppercase;
      letter-spacing: 0.15em;
    }
    .hero {
      margin-bottom: 3rem;
    }
    .hero .prompt {
      color: #555;
      font-size: 0.85rem;
      margin-bottom: 0.75rem;
    }
    .hero .cmd {
      font-size: 1.3rem;
      color: #fff;
      padding: 1rem 0;
      border-bottom: 1px solid #222;
      user-select: all;
    }
    .hero .cmd span {
      color: #555;
    }
    .section {
      margin-bottom: 2.5rem;
    }
    .section h2 {
      font-size: 0.7rem;
      color: #555;
      text-transform: uppercase;
      letter-spacing: 0.15em;
      margin-bottom: 1rem;
    }
    .section p {
      color: #aaa;
      font-size: 0.85rem;
      line-height: 1.7;
    }
    .section a {
      color: #fff;
      text-decoration: none;
      border-bottom: 1px solid #333;
    }
    .section a:hover {
      border-bottom-color: #fff;
    }
    .steps {
      list-style: none;
    }
    .steps li {
      color: #aaa;
      font-size: 0.85rem;
      padding: 0.6rem 0;
      border-bottom: 1px solid #111;
      display: flex;
      gap: 1rem;
    }
    .steps li::before {
      content: ">";
      color: #555;
      flex-shrink: 0;
    }
    .footer {
      margin-top: 3rem;
      padding-top: 1.5rem;
      border-top: 1px solid #111;
      font-size: 0.75rem;
      color: #fff;
    }
    .footer a {
      color: #555;
      text-decoration: none;
    }
    .footer a:hover {
      color: #fff;
    }
    .cursor {
      display: inline-block;
      width: 0.6em;
      height: 1em;
      background: #fff;
      vertical-align: text-bottom;
      animation: blink 1s step-end infinite;
    }
    @keyframes blink {
      50% { opacity: 0; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>lokly</h1>
    </div>

    <div class="hero">
      <div class="prompt">// expose localhost to the internet</div>
      <div class="cmd"><span>$</span> npx @deyoyk/lokly 3000<span class="cursor"></span></div>
    </div>

    <div class="section">
      <h2>usage</h2>
      <ol class="steps">
        <li>run your local server on any port</li>
        <li>run <span style="color:#fff;">npx @deyoyk/lokly &lt;port&gt;</span></li>
        <li>share the generated url</li>
      </ol>
    </div>

    <div class="footer">
      made with &lt;3 by <a href="https://github.com/deyoyk" style="color:#b388ff;">deyo</a>
    </div>
  </div>
</body>
</html>`;

const TUNNEL_OFFLINE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>tunnel offline — lokly</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: "SF Mono", "Fira Code", "Courier New", monospace;
      background: #000;
      color: #fff;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 2rem;
    }
    .container { max-width: 600px; width: 100%; }
    .header { border-bottom: 1px solid #333; padding-bottom: 1.5rem; margin-bottom: 2rem; }
    .header h1 { font-size: 1rem; font-weight: 400; color: #555; text-transform: uppercase; letter-spacing: 0.15em; }
    .status { margin-bottom: 3rem; }
    .status .code { font-size: 3rem; font-weight: 700; color: #ff4444; margin-bottom: 0.5rem; }
    .status .msg { color: #aaa; font-size: 1rem; }
    .info { color: #555; font-size: 0.85rem; line-height: 1.7; }
    .info a { color: #fff; text-decoration: none; border-bottom: 1px solid #333; }
    .info a:hover { border-bottom-color: #fff; }
    .footer { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid #111; font-size: 0.75rem; color: #fff; }
    .footer a { color: #555; text-decoration: none; }
    .footer a:hover { color: #fff; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>lokly</h1></div>
    <div class="status">
      <div class="code">502</div>
      <div class="msg">tunnel not connected</div>
    </div>
    <div class="info">
      no active tunnel for this URL.<br>
      start one with<br><br>
      <span style="color:#fff;">npx @deyoyk/lokly &lt;port&gt;</span>
    </div>
    <div class="footer">
      made with &lt;3 by <a href="https://github.com/deyoyk" style="color:#b388ff;">deyo</a>
    </div>
  </div>
</body>
</html>`;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
