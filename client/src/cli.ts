#!/usr/bin/env node

import WebSocket from "ws";
import qrcode from "qrcode-terminal";

const SERVER =
  process.env.LOKLY_SERVER || "wss://lokly.heydeyo.lol/register";

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

function main() {
  const port = parseInt(process.argv[2] || "", 10);
  if (!port || port < 1 || port > 65535) {
    console.error("Usage: lokly <port>");
    process.exit(1);
  }

  console.error(`Connecting to ${SERVER} ...`);

  const ws = new WebSocket(SERVER);

  ws.on("open", () => {
    // connected, wait for registration
  });

  ws.on("message", async (raw) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case "registered": {
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
