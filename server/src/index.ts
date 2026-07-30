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
  "publy.heydeyo.lol",
  "publy.ryme.workers.dev",
];

function isRootHost(host: string): boolean {
  return ROOT_HOSTS.includes(host);
}

function extractSubdomain(host: string): string | null {
  if (host.endsWith("-publy.heydeyo.lol")) {
    const prefix = host.slice(0, host.indexOf("-publy.heydeyo.lol"));
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
  return `https://${subdomain}-publy.heydeyo.lol`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const host = request.headers.get("host") || "";

    if (request.headers.get("Upgrade") === "websocket") {
      return handleRegister(request, env);
    }

    if (isRootHost(host)) {
      return new Response("publy tunnel server\n", {
        headers: { "content-type": "text/plain" },
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

  const host = request.headers.get("host") || "publy.heydeyo.lol";
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
    const host = url.searchParams.get("host") || "publy.heydeyo.lol";

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
