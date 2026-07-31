#!/usr/bin/env node

import WebSocket from "ws";
import qrcode from "qrcode-terminal";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVER =
  process.env.LOKLY_SERVER || "wss://lokly.heydeyo.lol/register";

const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8"));
const VERSION = pkg.version as string;

async function checkUpdate() {
  try {
    const res = await fetch("https://registry.npmjs.org/@deyoyk/lokly/latest");
    const data: any = await res.json();
    if (data.version && data.version !== VERSION) {
      console.error(`\n  Update available: ${VERSION} → ${data.version}`);
      console.error(`  Run: npm update -g @deyoyk/lokly\n`);
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
    if (arg === "--subdomain") {
      customSubdomain = args[++i];
      if (!customSubdomain) {
        console.error("Error: --subdomain requires a value");
        process.exit(1);
      }
    } else if (arg.startsWith("--subdomain=")) {
      customSubdomain = arg.slice("--subdomain=".length);
    } else if (port === undefined) {
      port = parseInt(arg, 10);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }

  if (!port || port < 1 || port > 65535) {
    console.error("Usage: npx @deyoyk/lokly <port> [--subdomain <name>]");
    process.exit(1);
  }

  let wsUrl = SERVER;
  if (customSubdomain) {
    const err = validateSubdomain(customSubdomain);
    if (err) {
      console.error(`Invalid subdomain "${customSubdomain}": ${err}`);
      process.exit(1);
    }
    wsUrl = `${SERVER}?subdomain=${encodeURIComponent(customSubdomain)}`;
  }

  console.error(`Connecting to ${SERVER} ...`);

  const ws = new WebSocket(wsUrl);

  ws.on("unexpected-response", (_req, res) => {
    let body = "";
    res.on("data", (chunk) => (body += chunk.toString()));
    res.on("end", () => {
      console.error(`\nServer rejected the request (${res.statusCode}).`);
      if (body.trim()) console.error(body.trim());
      process.exit(1);
    });
  });

  ws.on("open", () => {
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
        ws.send(JSON.stringify({ type: "register", subdomain: mySubdomain }));
        break;
      }

      case "registered": {
        mySubdomain = msg.subdomain;
        ws.send(JSON.stringify({ type: "register", subdomain: mySubdomain }));

        const url = msg.url;
        console.error(`\nTunnel active!`);
        console.error(`   Public URL: ${url}`);

        qrcode.generate(url, { small: true }, (qr) => {
          console.error(qr);
          console.error(`   Forwarding localhost:${port} -> ${url}`);
          console.error(`   Press Ctrl+C to stop\n`);
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
    console.error("\nTunnel closed.");
    process.exit(0);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
    process.exit(1);
  });

  process.on("SIGINT", () => {
    console.error("\nshutting down...");
    ws.close();
    process.exit(0);
  });
}

async function handleProxyRequest(
  ws: WebSocket,
  msg: RequestMessage,
  port: number
) {
  const url = `http://localhost:${port}${msg.path}`;

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

    ws.send(
      JSON.stringify({
        type: "response",
        id: msg.id,
        status: resp.status,
        headers: respHeaders,
        body: respBody.toString("base64"),
      })
    );
  } catch (err: any) {
    ws.send(
      JSON.stringify({
        type: "response",
        id: msg.id,
        status: 502,
        headers: { "content-type": "text/plain" },
        body: Buffer.from(`Bad Gateway: ${err.message}`).toString("base64"),
      })
    );
  }
}

main();
