import type { Env } from "./types";
import { isRootHost, extractSubdomain, sanitizeSubdomain, generateSubdomain, shardId } from "./subdomain";
import { ROOT_HTML } from "./html/root";
import { TunnelDO } from "./tunnel-do";

export { TunnelDO };

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
