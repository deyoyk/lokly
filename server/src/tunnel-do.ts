import { DurableObject } from "cloudflare:workers";
import type { Env, PendingRequest, ProxyResponse } from "./types";
import { tunnelUrl } from "./subdomain";
import { encodeEnvelope, decodeEnvelope, base64ToUint8Array } from "./envelope";
import { TUNNEL_OFFLINE_HTML } from "./html/offline";

const REQUEST_TIMEOUT = 30_000;
const RESTORE_TIMEOUT = 3_000;

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
