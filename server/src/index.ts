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

function tunnelUrl(subdomain: string, _host: string): string {
  return `https://${subdomain}-lokly.heydeyo.lol`;
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

    return handleProxy(request, env, host, subdomain);
  },
} satisfies ExportedHandler<Env>;

async function handleRegister(request: Request, env: Env): Promise<Response> {
  const subdomain = generateSubdomain();
  const doId = env.TUNNEL_DO.idFromName(subdomain);
  const stub = env.TUNNEL_DO.get(doId);

  const host = request.headers.get("host") || "lokly.heydeyo.lol";
  const url = new URL(request.url);
  url.searchParams.set("subdomain", subdomain);
  url.searchParams.set("host", host);
  const modified = new Request(url.toString(), request);
  return stub.fetch(modified);
}

async function handleProxy(request: Request, env: Env, host: string, subdomain: string): Promise<Response> {
  const doId = env.TUNNEL_DO.idFromName(subdomain);
  const stub = env.TUNNEL_DO.get(doId);
  return stub.fetch(request);
}

export class TunnelDO extends DurableObject<Env> {
  private subdomain: string | null = null;
  private pending = new Map<string, PendingRequest>();

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }
    return this.handleProxyRequest(request);
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.subdomain = url.searchParams.get("subdomain");
    const host = url.searchParams.get("host") || "lokly.heydeyo.lol";

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    server.send(
      JSON.stringify({
        type: "registered",
        subdomain: this.subdomain,
        url: tunnelUrl(this.subdomain!, host),
      })
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleProxyRequest(request: Request): Promise<Response> {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) {
      return new Response("Tunnel is not connected", { status: 502 });
    }

    const ws = sockets[0];
    const requestId = crypto.randomUUID();

    const body = request.body ? await request.arrayBuffer() : new ArrayBuffer(0);

    ws.send(
      JSON.stringify({
        type: "request",
        id: requestId,
        method: request.method,
        path: new URL(request.url).pathname + new URL(request.url).search,
        headers: Object.fromEntries(request.headers.entries()),
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
      color: #333;
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

    <div class="section">
      <h2>env</h2>
      <p><span style="color:#555;">LOKLY_SERVER</span> &nbsp; wss://lokly.heydeyo.lol/register</p>
    </div>

    <div class="section">
      <h2>how it works</h2>
      <p>
        WebSocket tunnel via Cloudflare Workers + Durable Objects.
        Zero persistence, free-tier friendly.
      </p>
    </div>

    <div class="footer">
      <a href="https://github.com/deyoyk/lokly">github</a>
      &nbsp;&middot;&nbsp;
      made by <a href="https://github.com/deyoyk">deyo</a>
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
