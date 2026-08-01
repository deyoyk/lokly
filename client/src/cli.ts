#!/usr/bin/env node

import WebSocket from "ws";
import qrcode from "qrcode-terminal";
import * as http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const SERVER =
  process.env.LOKLY_SERVER || "wss://lokly.heydeyo.lol/register";

const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8"));
const VERSION = pkg.version as string;

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function paint(text: string, color: string, bold = false): string {
  return `${bold ? c.bold : ""}${color}${text}${c.reset}`;
}

function statusColor(code: number): string {
  if (code < 300) return c.green;
  if (code < 400) return c.cyan;
  if (code < 500) return c.yellow;
  return c.red;
}

function methodColor(method: string): string {
  switch (method.toUpperCase()) {
    case "GET":
      return c.cyan;
    case "POST":
      return c.green;
    case "PUT":
    case "PATCH":
      return c.yellow;
    case "DELETE":
      return c.red;
    default:
      return c.gray;
  }
}

type DebugFilter = "all" | "upstream" | "downstream";

let DEBUG: DebugFilter | null = null;

function logStream(
  stream: "UPSTREAM" | "DOWNSTREAM",
  type: string,
  msg: string,
  detail = ""
) {
  if (!DEBUG) return;
  if (DEBUG !== "all" && DEBUG !== stream.toLowerCase()) return;
  const ts = new Date().toISOString().slice(11, 19);
  const streamColor = stream === "UPSTREAM" ? c.magenta : c.blue;
  const line = `${c.dim}${ts}${c.reset} ${paint(`[${stream}]`, streamColor, true)} ${paint(`[${type}]`, c.gray)} ${msg}`;
  console.error(detail ? `${line} ${c.dim}${detail}${c.reset}` : line);
}

let updateChecked = false;

async function checkUpdate() {
  try {
    const res = await fetch("https://registry.npmjs.org/@deyoyk/lokly/latest");
    const data: any = await res.json();
    if (data.version && data.version !== VERSION) {
      console.error(
        `\n  ${paint("Update available:", c.yellow, true)} ${VERSION} ${paint("->", c.gray)} ${paint(data.version, c.green)}`
      );
      console.error(
        `  ${paint("Run:", c.dim)} ${paint("npm update -g @deyoyk/lokly", c.cyan)}\n`
      );
    }
  } catch {}
}

interface RequestMessage {
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
}

interface ProxyResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

interface RequestEntry {
  id: string;
  ts: string;
  port: number;
  method: string;
  path: string;
  status: number;
  ms: number;
  reqHeaders: Record<string, string>;
  resHeaders: Record<string, string>;
  reqBody: Buffer;
  resBody: Buffer;
  truncated: boolean;
}

function validateSubdomain(name: string): string | null {
  const s = name.toLowerCase();
  if (
    s.length < 1 ||
    s.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(s)
  ) {
    return "must be 1-63 characters, letters, digits and hyphens only (no leading/trailing hyphen)";
  }
  if (s === "lokly") return "'lokly' is reserved";
  if (s.endsWith("-lokly")) return "cannot end with '-lokly'";
  return null;
}

function encodeEnvelope(json: object, body: Buffer | Uint8Array): Buffer {
  const jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(jsonBuf.byteLength, 0);
  return Buffer.concat([head, jsonBuf, Buffer.from(body)]);
}

function decodeEnvelope(data: WebSocket.RawData): { json: any; body: Buffer } {
  const buf = Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(data);
  const jsonLen = buf.readUInt32BE(0);
  const json = JSON.parse(buf.subarray(4, 4 + jsonLen).toString("utf8"));
  return { json, body: buf.subarray(4 + jsonLen) };
}

const HISTORY_MAX = 200;
const BODY_CAP = 512 * 1024;

const history: RequestEntry[] = [];
const tunnels: Tunnel[] = [];
let inspectorPort: number | null = 4040;
let inspectorPrinted = false;

function recordEntry(
  t: Tunnel,
  msg: RequestMessage,
  result: ProxyResult,
  ms: number,
  reqBody: Buffer
) {
  const truncated = reqBody.length > BODY_CAP || result.body.length > BODY_CAP;
  history.push({
    id: msg.id,
    ts: new Date().toISOString().slice(11, 19),
    port: t.port,
    method: msg.method,
    path: msg.path,
    status: result.status,
    ms,
    reqHeaders: msg.headers || {},
    resHeaders: result.headers,
    reqBody: reqBody.subarray(0, BODY_CAP),
    resBody: result.body.subarray(0, BODY_CAP),
    truncated,
  });
  if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
}

async function forwardRequest(
  t: Tunnel,
  msg: RequestMessage,
  reqBody: Buffer
): Promise<ProxyResult> {
  const method = paint(msg.method, methodColor(msg.method), true);
  const path = paint(msg.path, c.cyan);
  logStream(
    "UPSTREAM",
    "REQUEST",
    `${method} ${path}`,
    `id=${msg.id}${tunnels.length > 1 ? ` · port=${t.port}` : ""}`
  );

  const url = `http://localhost:${t.port}${msg.path}`;
  logStream(
    "DOWNSTREAM",
    "REQUEST",
    `forwarding ${method} ${paint(url, c.cyan)}`,
    `id=${msg.id}`
  );

  const start = Date.now();
  const headers = new Headers();
  for (const [k, v] of Object.entries(msg.headers || {})) {
    const lk = k.toLowerCase();
    if (
      lk !== "host" &&
      lk !== "content-length" &&
      lk !== "transfer-encoding" &&
      lk !== "connection"
    ) {
      try {
        headers.set(k, v);
      } catch {}
    }
  }

  let status: number;
  let resHeaders: Record<string, string> = {};
  let resBody: Buffer;
  let timedOut = false;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), t.timeoutSec * 1000);
    const resp = await fetch(url, {
      method: msg.method,
      headers,
      body:
        reqBody.length > 0
          ? (reqBody.buffer.slice(
              reqBody.byteOffset,
              reqBody.byteOffset + reqBody.byteLength
            ) as ArrayBuffer)
          : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);
    status = resp.status;
    resp.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });
    resBody = Buffer.from(await resp.arrayBuffer());
  } catch (err: any) {
    timedOut = err?.name === "AbortError";
    status = timedOut ? 504 : 502;
    resHeaders = { "content-type": "text/plain" };
    const errMsg = timedOut
      ? `Gateway Timeout: localhost:${t.port} did not respond within ${t.timeoutSec}s`
      : `Bad Gateway: ${err?.message || err}`;
    logStream("DOWNSTREAM", "ERROR", paint(errMsg, c.red), `id=${msg.id}`);
    resBody = Buffer.from(errMsg);
  }

  logStream(
    "DOWNSTREAM",
    "RESPONSE",
    `status=${paint(String(status), statusColor(status), true)}`,
    `body=${resBody.byteLength} B · id=${msg.id}`
  );
  recordEntry(t, msg, { status, headers: resHeaders, body: resBody }, Date.now() - start, reqBody);
  return { status, headers: resHeaders, body: resBody };
}

class Tunnel {
  readonly port: number;
  readonly customSubdomain?: string;
  readonly auth?: string;
  readonly timeoutSec: number;
  ws: WebSocket | null = null;
  mySubdomain = "";
  private attempt = 0;
  private manualClose = false;
  private connectedOnce = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;

  constructor(opts: {
    port: number;
    customSubdomain?: string;
    auth?: string;
    timeoutSec: number;
  }) {
    this.port = opts.port;
    this.customSubdomain = opts.customSubdomain;
    this.auth = opts.auth;
    this.timeoutSec = opts.timeoutSec;
  }

  get stopped(): boolean {
    return this.manualClose;
  }

  private label(): string {
    return tunnels.length > 1 ? `[${this.port}] ` : "";
  }

  private buildUrl(): string {
    let url = SERVER;
    const params: string[] = [];
    const sub = this.customSubdomain || this.mySubdomain;
    if (sub) {
      params.push(`subdomain=${encodeURIComponent(sub)}`);
    }
    if (this.auth) {
      params.push(
        `auth=${encodeURIComponent(Buffer.from(this.auth, "utf8").toString("base64"))}`
      );
    }
    if (params.length > 0) {
      url += (url.includes("?") ? "&" : "?") + params.join("&");
    }
    return url;
  }

  connect() {
    const url = this.buildUrl();
    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    this.ws = ws;

    ws.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk.toString()));
      res.on("end", () => {
        const statusCode = res.statusCode ?? 0;
        logStream(
          "UPSTREAM",
          "REJECT",
          `${paint(`HTTP ${statusCode}`, statusColor(statusCode), true)}`
        );
        if (!this.connectedOnce) {
          console.error(
            `\n${paint("Server rejected the request", c.red, true)} (${paint(String(statusCode), statusColor(statusCode))}).`
          );
          if (body.trim()) console.error(paint(body.trim(), c.yellow));
          process.exit(1);
        }
        this.manualClose = true;
        if (statusCode === 409 && this.customSubdomain) {
          console.error(
            `\n${paint(`Subdomain "${this.customSubdomain}" is no longer available.`, c.red, true)}`
          );
        } else {
          console.error(
            `\n${paint("Server rejected the reconnection", c.red, true)} (${paint(String(statusCode), statusColor(statusCode))}).`
          );
        }
        if (body.trim()) console.error(paint(body.trim(), c.yellow));
        ws.close();
      });
    });

    ws.on("open", () => this.onOpen());

    ws.on("message", (data, isBinary) => this.onMessage(data, isBinary));

    ws.on("close", () => this.onClose());

    ws.on("error", (err) => {
      logStream("UPSTREAM", "ERROR", err.message);
    });
  }

  private onOpen() {
    logStream("UPSTREAM", "CONNECT", "websocket open", this.buildUrl());
    if (!updateChecked) {
      updateChecked = true;
      checkUpdate();
    }
    this.stableTimer = setTimeout(() => {
      this.attempt = 0;
    }, 30_000);
  }

  private onClose() {
    logStream("UPSTREAM", "CLOSE", "tunnel closed");
    this.ws = null;
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
    if (this.manualClose) {
      maybeExit();
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    const delay = Math.min(30_000, 1_000 * 2 ** this.attempt);
    this.attempt++;
    logStream(
      "UPSTREAM",
      "RECONNECT",
      `attempt in ${Math.round(delay / 1000)}s (attempt ${this.attempt})`
    );
    console.error(
      `  ${this.label()}${paint("Connection lost. Reconnecting", c.yellow)} ${paint(`in ${Math.round(delay / 1000)}s...`, c.gray)}`
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.manualClose) this.connect();
    }, delay);
  }

  private sendRegister() {
    this.ws?.send(JSON.stringify({ type: "register", subdomain: this.mySubdomain }));
  }

  private onMessage(data: WebSocket.RawData, isBinary: boolean) {
    if (isBinary) {
      let json: any;
      let body: Buffer;
      try {
        ({ json, body } = decodeEnvelope(data));
      } catch {
        return;
      }
      this.handleServerMessage(json, body);
      return;
    }

    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    this.handleServerMessage(msg, null);
  }

  private handleServerMessage(msg: any, binaryBody: Buffer | null) {
    switch (msg.type) {
      case "whoami": {
        logStream("UPSTREAM", "WHOAMI", "identity request -> re-registering");
        this.sendRegister();
        break;
      }

      case "registered": {
        this.mySubdomain = msg.subdomain;
        this.sendRegister();

        if (!this.connectedOnce) {
          this.connectedOnce = true;
          this.attempt = 0;
          this.printBanner(msg.url);
        } else {
          logStream(
            "UPSTREAM",
            "REGISTERED",
            `subdomain=${paint(this.mySubdomain, c.green, true)}`,
            `url=${msg.url}`
          );
          console.error(
            `  ${this.label()}${paint("Reconnected:", c.green, true)} ${paint(msg.url, c.cyan)}`
          );
        }
        break;
      }

      case "request": {
        const body =
          binaryBody !== null
            ? binaryBody
            : Buffer.from(msg.body || "", "base64");
        this.handleRequest(
          {
            id: msg.id,
            method: msg.method,
            path: msg.path,
            headers: msg.headers || {},
          },
          body
        );
        break;
      }
    }
  }

  private printBanner(url: string) {
    console.error(`\n  ${this.label()}${paint("Tunnel active!", c.green, true)}`);
    console.error(
      `   ${this.label()}${paint("Public URL:", c.gray)} ${paint(url, c.cyan, true)}`
    );

    qrcode.generate(url, { small: true }, (qr) => {
      console.error(qr);
      console.error(
        `   ${this.label()}${paint("Forwarding", c.gray)} ${paint(`localhost:${this.port}`, c.cyan)} ${paint("->", c.gray)} ${paint(url, c.cyan)}`
      );
      if (inspectorPort !== null && !inspectorPrinted) {
        inspectorPrinted = true;
        console.error(
          `   ${this.label()}${paint("Inspector:", c.gray)} ${paint(`http://localhost:${inspectorPort}`, c.cyan)}`
        );
      }
      console.error(`   ${this.label()}${paint("Press Ctrl+C to stop", c.dim)}\n`);
    });
  }

  private async handleRequest(msg: RequestMessage, body: Buffer) {
    const result = await forwardRequest(this, msg, body);
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        encodeEnvelope(
          {
            type: "response",
            id: msg.id,
            status: result.status,
            headers: result.headers,
          },
          result.body
        )
      );
      logStream(
        "UPSTREAM",
        "RESPONSE",
        `sent ${paint(String(result.status), statusColor(result.status), true)} back to server`,
        `id=${msg.id}`
      );
    }
  }

  stop() {
    this.manualClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
  }
}

function maybeExit() {
  if (tunnels.length > 0 && tunnels.every((t) => t.stopped)) {
    console.error(`\n${paint("All tunnels closed.", c.yellow)}`);
    process.exit(0);
  }
}

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function listRequests() {
  return history
    .map((e) => ({
      id: e.id,
      ts: e.ts,
      port: e.port,
      method: e.method,
      path: e.path,
      status: e.status,
      ms: e.ms,
      size: e.resBody.length,
    }))
    .reverse();
}

function entryDetail(e: RequestEntry) {
  return {
    id: e.id,
    ts: e.ts,
    port: e.port,
    method: e.method,
    path: e.path,
    status: e.status,
    ms: e.ms,
    reqHeaders: e.reqHeaders,
    resHeaders: e.resHeaders,
    reqBodyBase64: e.reqBody.length ? e.reqBody.toString("base64") : "",
    resBodyBase64: e.resBody.length ? e.resBody.toString("base64") : "",
    truncated: e.truncated,
  };
}

async function handleInspectorRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
) {
  const url = new URL(req.url || "/", "http://localhost");
  const p = url.pathname;

  if (req.method === "GET" && p === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(INSPECTOR_HTML);
    return;
  }

  if (req.method === "GET" && p === "/api/requests") {
    sendJson(res, 200, listRequests());
    return;
  }

  let m = p.match(/^\/api\/requests\/([^/]+)$/);
  if (m && req.method === "GET") {
    const entry = history.find((e) => e.id === m![1]);
    if (!entry) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    sendJson(res, 200, entryDetail(entry));
    return;
  }

  m = p.match(/^\/api\/requests\/([^/]+)\/replay$/);
  if (m && req.method === "POST") {
    const entry = history.find((e) => e.id === m![1]);
    if (!entry) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const tunnel = tunnels.find((t) => t.port === entry.port && !t.stopped);
    if (!tunnel) {
      sendJson(res, 400, { error: `no active tunnel on port ${entry.port}` });
      return;
    }
    const result = await forwardRequest(
      tunnel,
      {
        id: randomUUID(),
        method: entry.method,
        path: entry.path,
        headers: entry.reqHeaders,
      },
      entry.reqBody
    );
    sendJson(res, 200, {
      status: result.status,
      headers: result.headers,
      bodyBase64: result.body.toString("base64"),
    });
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

function startInspector(port: number) {
  const server = http.createServer((req, res) => {
    handleInspectorRequest(req, res).catch((err: any) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: String(err?.message || err) });
      } else {
        res.end();
      }
    });
  });
  server.on("error", (err: any) => {
    if (err?.code === "EADDRINUSE") {
      console.error(
        `  ${paint(`Inspector port ${port} is busy — running without dashboard.`, c.yellow)}`
      );
      inspectorPort = null;
    }
  });
  server.listen(port, "127.0.0.1");
}

function usage() {
  console.error(
    `Usage: ${paint("npx @deyoyk/lokly <port> [port...]", c.cyan)} [options]`
  );
  console.error(`\nOptions:`);
  console.error(`  ${paint("--subdomain <name>", c.cyan)}       custom public URL (repeatable, pairs with ports)`);
  console.error(`  ${paint("--auth <user:pass>", c.cyan)}       password-protect the public URL (HTTP Basic Auth)`);
  console.error(`  ${paint("--timeout <seconds>", c.cyan)}      per-request timeout (default: 30)`);
  console.error(`  ${paint("--inspector-port <n>", c.cyan)}     request inspector UI port (default: 4040)`);
  console.error(`  ${paint("--debug [direction]", c.cyan)}      show stream logs: all | upstream | downstream`);
}

function main() {
  const args = process.argv.slice(2);
  const ports: number[] = [];
  const subdomains: string[] = [];
  let auth: string | undefined;
  let timeoutSec = 30;

  const fail = (msg: string) => {
    console.error(`${paint("Error:", c.red, true)} ${msg}`);
    process.exit(1);
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--debug" || arg.startsWith("--debug=")) {
      let val: string;
      if (arg === "--debug") {
        const next = args[i + 1];
        if (next === "upstream" || next === "downstream") {
          val = next;
          i++;
        } else {
          val = "all";
        }
      } else {
        val = arg.slice("--debug=".length);
      }
      if (val !== "all" && val !== "upstream" && val !== "downstream") {
        fail(`invalid --debug value "${val}" — expected: all | upstream | downstream`);
      }
      DEBUG = val as DebugFilter;
    } else if (arg === "--subdomain") {
      const v = args[++i];
      if (!v) fail("--subdomain requires a value");
      subdomains.push(v);
    } else if (arg.startsWith("--subdomain=")) {
      subdomains.push(arg.slice("--subdomain=".length));
    } else if (arg === "--auth") {
      const v = args[++i];
      if (!v) fail("--auth requires a value");
      auth = v;
    } else if (arg.startsWith("--auth=")) {
      auth = arg.slice("--auth=".length);
    } else if (arg === "--timeout") {
      const v = parseInt(args[++i], 10);
      if (!v || v < 1) fail("--timeout requires a positive number of seconds");
      timeoutSec = v;
    } else if (arg.startsWith("--timeout=")) {
      const v = parseInt(arg.slice("--timeout=".length), 10);
      if (!v || v < 1) fail("--timeout requires a positive number of seconds");
      timeoutSec = v;
    } else if (arg === "--inspector-port") {
      const v = parseInt(args[++i], 10);
      if (!v || v < 1 || v > 65535) fail("--inspector-port requires a valid port (1-65535)");
      inspectorPort = v;
    } else if (arg.startsWith("--inspector-port=")) {
      const v = parseInt(arg.slice("--inspector-port=".length), 10);
      if (!v || v < 1 || v > 65535) fail("--inspector-port requires a valid port (1-65535)");
      inspectorPort = v;
    } else if (/^\d+$/.test(arg)) {
      ports.push(parseInt(arg, 10));
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }

  if (ports.length === 0 || ports.some((p) => p < 1 || p > 65535)) {
    usage();
    process.exit(1);
  }
  if (subdomains.length > ports.length) {
    fail(`got ${subdomains.length} --subdomain(s) for ${ports.length} port(s)`);
  }
  for (const sd of subdomains) {
    const err = validateSubdomain(sd);
    if (err) fail(`invalid subdomain "${sd}": ${err}`);
  }
  if (auth && !auth.includes(":")) {
    fail('--auth must be in "user:pass" format');
  }

  for (let i = 0; i < ports.length; i++) {
    const t = new Tunnel({
      port: ports[i],
      customSubdomain: subdomains[i],
      auth,
      timeoutSec,
    });
    tunnels.push(t);
    t.connect();
  }

  if (inspectorPort !== null) startInspector(inspectorPort);

  process.on("SIGINT", () => {
    console.error(`\n${paint("Shutting down...", c.yellow)}`);
    tunnels.forEach((t) => t.stop());
    process.exit(0);
  });
}

const INSPECTOR_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>lokly · inspector</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: "SF Mono", "Fira Code", "Courier New", monospace; background: #000; color: #fff; padding: 2rem; }
    header { border-bottom: 1px solid #333; padding-bottom: 1rem; margin-bottom: 1.5rem; display: flex; justify-content: space-between; align-items: baseline; }
    header h1 { font-size: 1rem; font-weight: 400; color: #555; text-transform: uppercase; letter-spacing: 0.15em; }
    header h1 span { color: #b388ff; }
    #count { color: #555; font-size: 0.8rem; }
    #filter { background: #111; border: 1px solid #333; color: #fff; font-family: inherit; padding: 0.4rem 0.6rem; width: 100%; margin-bottom: 1rem; font-size: 0.85rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th { color: #555; text-align: left; font-weight: 400; text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.1em; padding: 0.4rem 0.6rem; border-bottom: 1px solid #333; }
    td { padding: 0.45rem 0.6rem; border-bottom: 1px solid #111; white-space: nowrap; }
    tr:hover td { background: #111; cursor: pointer; }
    .s2 { color: #4ade80; } .s3 { color: #22d3ee; } .s4 { color: #facc15; } .s5 { color: #f87171; }
    .m2 { color: #4ade80; } .m3 { color: #22d3ee; } .m4 { color: #facc15; } .m5 { color: #f87171; } .mm { color: #aaa; }
    .path { color: #fff; max-width: 40vw; overflow: hidden; text-overflow: ellipsis; }
    .ms, .size { color: #888; }
    #detail { margin-top: 1.5rem; border-top: 1px solid #333; padding-top: 1rem; display: none; }
    #detail h2 { font-size: 0.7rem; color: #555; text-transform: uppercase; letter-spacing: 0.15em; margin-bottom: 0.75rem; }
    pre { background: #111; border: 1px solid #222; padding: 0.75rem; font-size: 0.8rem; color: #ccc; overflow-x: auto; max-height: 30vh; overflow-y: auto; margin-bottom: 0.75rem; white-space: pre-wrap; word-break: break-word; }
    button { background: #1a1a1a; color: #fff; border: 1px solid #333; font-family: inherit; font-size: 0.8rem; padding: 0.4rem 1rem; cursor: pointer; }
    button:hover { background: #2a2a2a; }
    #replayResult { margin-top: 0.75rem; color: #aaa; font-size: 0.8rem; }
    .empty { color: #555; padding: 2rem 0; text-align: center; }
  </style>
</head>
<body>
  <header>
    <h1>lokly <span>inspector</span></h1>
    <div id="count">0 requests</div>
  </header>
  <input id="filter" placeholder="filter by method, path, status or port...">
  <table>
    <thead><tr><th>time</th><th>port</th><th>method</th><th>path</th><th>status</th><th>duration</th><th>size</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <div id="detail"></div>
<script>
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
let detailId = null;
const statusClass = (code) => "s" + Math.floor(code / 100);
const methodClass = (m) => "m" + (m === "GET" ? 2 : m === "POST" ? 3 : m === "PUT" || m === "PATCH" ? 4 : 5);
const fmt = (n) => n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(2) + " MB";
function b64text(b64) {
  try {
    const bin = atob(b64);
    return bin.length > 5000 ? bin.slice(0, 5000) + "\\n...(truncated preview)" : bin;
  } catch { return b64.slice(0, 5000); }
}
async function refresh() {
  try {
    const list = await (await fetch("/api/requests")).json();
    const q = ($("#filter").value || "").toLowerCase();
    $("#count").textContent = list.length + " request" + (list.length === 1 ? "" : "s");
    const rows = $("#rows");
    rows.innerHTML = "";
    const filtered = list.filter((r) => !q || r.method.toLowerCase().includes(q) || r.path.toLowerCase().includes(q) || String(r.status).includes(q) || String(r.port).includes(q));
    if (!filtered.length) rows.innerHTML = '<tr><td colspan="7" class="empty">no requests yet — hit your tunnel url</td></tr>';
    for (const r of filtered) {
      const tr = document.createElement("tr");
      tr.innerHTML = '<td>' + esc(r.ts) + '</td><td>' + esc(r.port) + '</td><td class="' + methodClass(r.method) + '">' + esc(r.method) + '</td><td class="path">' + esc(r.path) + '</td><td class="' + statusClass(r.status) + '">' + r.status + '</td><td class="ms">' + r.ms + 'ms</td><td class="size">' + fmt(r.size) + '</td>';
      tr.onclick = () => { detailId = r.id; showDetail(r.id); };
      if (r.id === detailId) tr.style.background = "#1a1a1a";
      rows.appendChild(tr);
    }
  } catch {}
}
async function showDetail(id) {
  const d = await (await fetch("/api/requests/" + id)).json();
  const el = $("#detail");
  el.style.display = "block";
  const hdr = Object.entries(d.reqHeaders).map(([k, v]) => '<div><b>' + esc(k) + ':</b> ' + esc(v) + '</div>').join("");
  const resHdr = Object.entries(d.resHeaders).map(([k, v]) => '<div><b>' + esc(k) + ':</b> ' + esc(v) + '</div>').join("");
  el.innerHTML =
    '<h2>request ' + esc(d.id.slice(0, 8)) + ' · ' + esc(d.method) + ' ' + esc(d.path) + ' → ' + d.status + ' (' + d.ms + 'ms)</h2>' +
    '<h2>request headers</h2><pre>' + (hdr || "—") + '</pre>' +
    (d.reqBodyBase64 ? '<h2>request body' + (d.truncated ? " (truncated)" : "") + '</h2><pre>' + esc(b64text(d.reqBodyBase64)) + '</pre>' : "") +
    '<h2>response headers</h2><pre>' + (resHdr || "—") + '</pre>' +
    (d.resBodyBase64 ? '<h2>response body' + (d.truncated ? " (truncated)" : "") + '</h2><pre>' + esc(b64text(d.resBodyBase64)) + '</pre>' : "") +
    '<button onclick="replay(\'' + d.id + '\')">replay request</button>' +
    '<div id="replayResult"></div>';
}
async function replay(id) {
  const box = $("#replayResult");
  box.textContent = "replaying...";
  try {
    const r = await fetch("/api/requests/" + id + "/replay", { method: "POST" }).then((r) => r.json());
    box.textContent = "replay → " + r.status + " (" + (r.headers["content-type"] || "no content-type") + ")";
  } catch (e) {
    box.textContent = "replay failed: " + e.message;
  }
}
$("#filter").addEventListener("input", refresh);
setInterval(refresh, 1000);
refresh();
</script>
</body>
</html>`;

main();
