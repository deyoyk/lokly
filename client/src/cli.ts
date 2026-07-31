#!/usr/bin/env node

import WebSocket from "ws";
import qrcode from "qrcode-terminal";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

let DEBUG = false;

function logStream(
  stream: "UPSTREAM" | "DOWNSTREAM",
  type: string,
  msg: string,
  detail = ""
) {
  if (!DEBUG) return;
  const ts = new Date().toISOString().slice(11, 19);
  const streamColor = stream === "UPSTREAM" ? c.magenta : c.blue;
  const line = `${c.dim}${ts}${c.reset} ${paint(`[${stream}]`, streamColor, true)} ${paint(`[${type}]`, c.gray)} ${msg}`;
  console.error(detail ? `${line} ${c.dim}${detail}${c.reset}` : line);
}

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
  type: "request";
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

interface RegisteredMessage {
  type: "registered";
  subdomain: string;
  url: string;
}

type ServerMessage = RequestMessage | RegisteredMessage;

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

function main() {
  const args = process.argv.slice(2);
  let port: number | undefined;
  let customSubdomain: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--debug") {
      DEBUG = true;
    } else if (arg === "--subdomain") {
      customSubdomain = args[++i];
      if (!customSubdomain) {
        console.error(paint("Error: --subdomain requires a value", c.red, true));
        process.exit(1);
      }
    } else if (arg.startsWith("--subdomain=")) {
      customSubdomain = arg.slice("--subdomain=".length);
    } else if (port === undefined) {
      port = parseInt(arg, 10);
    } else {
      console.error(`${paint("Unknown argument:", c.red, true)} ${arg}`);
      process.exit(1);
    }
  }

  if (!port || port < 1 || port > 65535) {
    console.error(
      `Usage: ${paint("npx @deyoyk/lokly <port>", c.cyan)} ${paint("[--subdomain <name>]", c.gray)} ${paint("[--debug]", c.gray)}`
    );
    process.exit(1);
  }

  let wsUrl = SERVER;
  if (customSubdomain) {
    const err = validateSubdomain(customSubdomain);
    if (err) {
      console.error(
        `${paint('Invalid subdomain "' + customSubdomain + '":', c.red, true)} ${err}`
      );
      process.exit(1);
    }
    wsUrl = `${SERVER}?subdomain=${encodeURIComponent(customSubdomain)}`;
  }


  const ws = new WebSocket(wsUrl);

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
      console.error(
        `\n${paint("Server rejected the request", c.red, true)} (${paint(String(statusCode), statusColor(statusCode))}).`
      );
      if (body.trim()) console.error(paint(body.trim(), c.yellow));
      process.exit(1);
    });
  });

  ws.on("open", () => {
    logStream("UPSTREAM", "CONNECT", "websocket open", wsUrl);
    checkUpdate();
  });

  let mySubdomain = "";

  ws.on("message", async (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case "whoami": {
        logStream("UPSTREAM", "WHOAMI", "identity request -> re-registering");
        ws.send(JSON.stringify({ type: "register", subdomain: mySubdomain }));
        break;
      }

      case "registered": {
        mySubdomain = msg.subdomain;
        ws.send(JSON.stringify({ type: "register", subdomain: mySubdomain }));

        const url = msg.url;
        logStream(
          "UPSTREAM",
          "REGISTERED",
          `subdomain=${paint(mySubdomain, c.green, true)}`,
          `url=${url}`
        );
        console.error(`\n${paint("Tunnel active!", c.green, true)}`);
        console.error(`   ${paint("Public URL:", c.gray)} ${paint(url, c.cyan, true)}`);

        qrcode.generate(url, { small: true }, (qr) => {
          console.error(qr);
          console.error(
            `   ${paint("Forwarding", c.gray)} ${paint(`localhost:${port}`, c.cyan)} ${paint("->", c.gray)} ${paint(url, c.cyan)}`
          );
          console.error(
            `   ${paint("Press Ctrl+C to stop", c.dim)}\n`
          );
        });
        break;
      }

      case "request": {
        handleProxyRequest(ws, msg, port);
        break;
      }
    }
  });

  ws.on("close", () => {
    logStream("UPSTREAM", "CLOSE", "tunnel closed");
    console.error(`\n${paint("Tunnel closed.", c.yellow)}`);
    process.exit(0);
  });

  ws.on("error", (err) => {
    logStream("UPSTREAM", "ERROR", err.message);
    console.error(`${paint("WebSocket error:", c.red, true)} ${err.message}`);
    process.exit(1);
  });

  process.on("SIGINT", () => {
    console.error(`\n${paint("Shutting down...", c.yellow)}`);
    ws.close();
    process.exit(0);
  });
}

async function handleProxyRequest(
  ws: WebSocket,
  msg: RequestMessage,
  port: number
) {
  const method = paint(msg.method, methodColor(msg.method), true);
  const path = paint(msg.path, c.cyan);
  logStream(
    "UPSTREAM",
    "REQUEST",
    `${method} ${path}`,
    `id=${msg.id}`
  );

  const url = `http://localhost:${port}${msg.path}`;
  logStream(
    "DOWNSTREAM",
    "REQUEST",
    `forwarding ${method} ${paint(url, c.cyan)}`,
    `id=${msg.id}`
  );

  try {
    const headers = new Headers();
    for (const [k, v] of Object.entries(msg.headers)) {
      const lk = k.toLowerCase();
      if (
        lk !== "host" &&
        lk !== "content-length" &&
        lk !== "transfer-encoding" &&
        lk !== "connection"
      ) {
        headers.set(k, v);
      }
    }

    const body = msg.body ? Buffer.from(msg.body, "base64") : undefined;

    const resp = await fetch(url, {
      method: msg.method,
      headers,
      body,
    });

    const respHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      respHeaders[k] = v;
    });

    const respBody = Buffer.from(await resp.arrayBuffer());

    logStream(
      "DOWNSTREAM",
      "RESPONSE",
      `status=${paint(String(resp.status), statusColor(resp.status), true)}`,
      `body=${respBody.byteLength} B · id=${msg.id}`
    );

    ws.send(
      JSON.stringify({
        type: "response",
        id: msg.id,
        status: resp.status,
        headers: respHeaders,
        body: respBody.toString("base64"),
      })
    );

    logStream(
      "UPSTREAM",
      "RESPONSE",
      `sent ${paint(String(resp.status), statusColor(resp.status), true)} back to server`,
      `id=${msg.id}`
    );
  } catch (err: any) {
    logStream(
      "DOWNSTREAM",
      "ERROR",
      paint(`Bad Gateway: ${err.message}`, c.red)
    );
    ws.send(
      JSON.stringify({
        type: "response",
        id: msg.id,
        status: 502,
        headers: { "content-type": "text/plain" },
        body: Buffer.from(`Bad Gateway: ${err.message}`).toString("base64"),
      })
    );
    logStream(
      "UPSTREAM",
      "RESPONSE",
      `sent ${paint("502", statusColor(502), true)} back to server`,
      `id=${msg.id}`
    );
  }
}

main();
