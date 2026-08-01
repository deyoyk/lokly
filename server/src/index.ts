import { DurableObject } from "cloudflare:workers";

interface Env {
  TUNNEL_DO: DurableObjectNamespace<TunnelDO>;
}

interface PendingRequest {
  resolve: (response: ProxyResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  ws: WebSocket;
}

interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

const REQUEST_TIMEOUT = 30_000;
const RESTORE_TIMEOUT = 3_000;
const SHARDS = 10;

function generateSubdomain(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function sanitizeSubdomain(raw: string | null): { subdomain?: string; error?: string } {
  if (!raw) return {};
  const s = raw.toLowerCase();
  if (
    s.length < 1 ||
    s.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(s)
  ) {
    return { error: "Invalid subdomain: must be 1-63 characters, letters, digits and hyphens only (no leading/trailing hyphen)" };
  }
  if (s === "lokly") return { error: "Subdomain 'lokly' is reserved" };
  if (s.endsWith("-lokly")) return { error: "Subdomain cannot end with '-lokly'" };
  return { subdomain: s };
}

const BASE_HOST = "heydeyo.lol";

const ROOT_HOSTS = [
  "lokly.heydeyo.lol",
];

function isRootHost(host: string): boolean {
  return ROOT_HOSTS.includes(host);
}

function extractSubdomain(host: string): string | null {
  if (host.endsWith("-lokly.heydeyo.lol")) {
    const prefix = host.slice(0, host.indexOf("-lokly.heydeyo.lol"));
    if (prefix) return prefix;
  }
  const baseParts = BASE_HOST.split(".");
  const parts = host.split(".");
  if (
    parts.length === baseParts.length + 1 &&
    parts.slice(1).join(".") === BASE_HOST
  ) {
    return parts[0];
  }
  for (const root of ROOT_HOSTS) {
    const rootParts = root.split(".");
    if (parts.length === rootParts.length + 1) {
      const subdomain = parts[0];
      const rest = parts.slice(1).join(".");
      if (rest === root) return subdomain;
    }
  }
  return null;
}

function tunnelUrl(subdomain: string, custom: boolean): string {
  return custom
    ? `https://${subdomain}.heydeyo.lol`
    : `https://${subdomain}-lokly.heydeyo.lol`;
}

function shardId(subdomain: string): number {
  return subdomain.charCodeAt(0) % SHARDS;
}

function encodeEnvelope(json: object, body: Uint8Array): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const out = new Uint8Array(4 + jsonBytes.byteLength + body.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, jsonBytes.byteLength, false);
  out.set(jsonBytes, 4);
  out.set(body, 4 + jsonBytes.byteLength);
  return out;
}

function decodeEnvelope(data: Uint8Array): { json: any; body: Uint8Array } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const jsonLen = view.getUint32(0, false);
  const json = JSON.parse(
    new TextDecoder().decode(data.subarray(4, 4 + jsonLen))
  );
  return { json, body: data.subarray(4 + jsonLen) };
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
  const url = new URL(request.url);
  const { subdomain, error } = sanitizeSubdomain(url.searchParams.get("subdomain"));
  if (error) {
    return new Response(error, {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const finalSubdomain = subdomain ?? generateSubdomain();
  const doId = env.TUNNEL_DO.idFromName(`tunnel-${shardId(finalSubdomain)}`);
  const stub = env.TUNNEL_DO.get(doId);

  const host = request.headers.get("host") || "lokly.heydeyo.lol";
  url.searchParams.set("subdomain", finalSubdomain);
  url.searchParams.set("custom", subdomain ? "1" : "0");
  url.searchParams.set("host", host);
  const modified = new Request(url.toString(), request);
  return stub.fetch(modified);
}

async function handleProxy(request: Request, env: Env, subdomain: string): Promise<Response> {
  const doId = env.TUNNEL_DO.idFromName(`tunnel-${shardId(subdomain)}`);
  const stub = env.TUNNEL_DO.get(doId);
  const modified = new Request(request.url, request);
  modified.headers.set("x-subdomain", subdomain);
  return stub.fetch(modified);
}

export class TunnelDO extends DurableObject<Env> {
  private subdomainToWs = new Map<string, WebSocket>();
  private pending = new Map<string, PendingRequest>();
  private restoreWaiters = new Map<string, () => void>();

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }
    return this.handleProxyRequest(request);
  }

  private waitForSubdomain(subdomain: string, timeoutMs: number): Promise<WebSocket | undefined> {
    return new Promise((resolve) => {
      const existing = this.subdomainToWs.get(subdomain);
      if (existing) {
        resolve(existing);
        return;
      }
      const timer = setTimeout(() => {
        this.restoreWaiters.delete(subdomain);
        resolve(this.subdomainToWs.get(subdomain));
      }, timeoutMs);
      this.restoreWaiters.set(subdomain, () => {
        clearTimeout(timer);
        resolve(this.subdomainToWs.get(subdomain));
      });
    });
  }

  private rebuildFromAttachments(): void {
    if (this.subdomainToWs.size > 0) return;
    for (const s of this.ctx.getWebSockets()) {
      const sub = s.deserializeAttachment();
      if (typeof sub === "string" && !this.subdomainToWs.has(sub)) {
        this.subdomainToWs.set(sub, s);
      }
    }
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const subdomain = url.searchParams.get("subdomain")!;
    const host = url.searchParams.get("host") || "lokly.heydeyo.lol";
    const custom = url.searchParams.get("custom") === "1";
    const auth = url.searchParams.get("auth");

    if (custom) {
      this.rebuildFromAttachments();
      if (this.subdomainToWs.has(subdomain)) {
        return new Response(
          `Subdomain '${subdomain}' is unavaiable`,
          {
            status: 409,
            headers: { "content-type": "text/plain; charset=utf-8" },
          }
        );
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(subdomain);
    this.subdomainToWs.set(subdomain, server);

    if (auth) {
      await this.ctx.storage.put(`auth:${subdomain}`, auth);
    }

    server.send(
      JSON.stringify({
        type: "registered",
        subdomain,
        url: tunnelUrl(subdomain, custom),
      })
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleProxyRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const subdomain = request.headers.get("x-subdomain") || "";

    const auth = await this.ctx.storage.get<string>(`auth:${subdomain}`);
    if (auth) {
      const expected = `Basic ${auth}`;
      const provided = request.headers.get("authorization") || "";
      if (provided !== expected) {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            "www-authenticate": 'Basic realm="lokly"',
            "content-type": "text/plain; charset=utf-8",
          },
        });
      }
    }

    let ws = this.subdomainToWs.get(subdomain);

    if (!ws) {
      this.rebuildFromAttachments();
      ws = this.subdomainToWs.get(subdomain);
    }

    if (!ws && this.ctx.getWebSockets().length > 0) {
      for (const s of this.ctx.getWebSockets()) {
        s.send(JSON.stringify({ type: "whoami" }));
      }
      ws = await this.waitForSubdomain(subdomain, RESTORE_TIMEOUT);
    }

    const requestId = crypto.randomUUID();
    const body = request.body
      ? new Uint8Array(await request.arrayBuffer())
      : new Uint8Array(0);

    if (ws) {
      try {
        ws.send(
          encodeEnvelope(
            {
              type: "request",
              id: requestId,
              method: request.method,
              path: url.pathname + url.search,
              headers: Object.fromEntries(
                [...request.headers.entries()].filter(
                  ([k]) => k.toLowerCase() !== "x-subdomain"
                )
              ),
            },
            body
          )
        );
      } catch {
        this.subdomainToWs.delete(subdomain);
        ws = undefined;
      }
    }

    if (!ws) {
      if (this.ctx.getWebSockets().length > 0) {
        for (const s of this.ctx.getWebSockets()) {
          s.send(JSON.stringify({ type: "whoami" }));
        }
        ws = await this.waitForSubdomain(subdomain, RESTORE_TIMEOUT);
      }
    }

    if (!ws) {
      return new Response(TUNNEL_OFFLINE_HTML, {
        status: 502,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

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
          resolve(
            new Response(proxyResp.body, {
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
        ws,
      });
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message === "string") {
      let data: any;
      try {
        data = JSON.parse(message);
      } catch {
        return;
      }

      if (data.type === "register" && data.subdomain) {
        this.subdomainToWs.set(data.subdomain, ws);
        ws.serializeAttachment(data.subdomain);
        const waiter = this.restoreWaiters.get(data.subdomain);
        if (waiter) {
          this.restoreWaiters.delete(data.subdomain);
          waiter();
        }
        return;
      }

      if (data.type === "response" && data.id) {
        const pending = this.pending.get(data.id);
        if (pending) {
          this.pending.delete(data.id);
          const body = data.body
            ? base64ToUint8Array(data.body)
            : new Uint8Array(0);
          pending.resolve({
            status: data.status || 200,
            headers: data.headers || {},
            body,
          });
        }
      }
      return;
    }

    const { json, body } = decodeEnvelope(new Uint8Array(message));
    if (json.type === "response" && json.id) {
      const pending = this.pending.get(json.id);
      if (pending) {
        this.pending.delete(json.id);
        pending.resolve({
          status: json.status || 200,
          headers: json.headers || {},
          body,
        });
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    for (const [sd, w] of this.subdomainToWs) {
      if (w === ws) {
        this.subdomainToWs.delete(sd);
        await this.ctx.storage.delete(`auth:${sd}`);
        break;
      }
    }
    for (const [id, pending] of this.pending) {
      if (pending.ws === ws) {
        this.pending.delete(id);
        pending.reject(new Error("Tunnel closed"));
      }
    }
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    console.error(`websocket error: ${String(error)}`);
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
      <div class="cmd"><span>$</span> npx @deyoyk/lokly 3000 --subdomain myname<span class="cursor"></span></div>
    </div>

    <div class="section">
      <h2>usage</h2>
      <ol class="steps">
        <li>run your local server on any port</li>
        <li>run <span style="color:#fff;">npx @deyoyk/lokly &lt;port&gt;</span></li>
        <li>add <span style="color:#fff;">--subdomain &lt;name&gt;</span> for a custom url: <span style="color:#fff;">&lt;name&gt;.heydeyo.lol</span></li>
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

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
