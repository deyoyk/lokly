# lokale

Instant HTTP tunnels for local servers.

```
npx lokale 3000
```

```
Connecting to wss://lokale.heydeyo.lol/register ...

Tunnel active!
   Public URL: https://abc123-lokale.heydeyo.lol
   [QR code]

   Forwarding localhost:3000 -> https://abc123-lokale.heydeyo.lol
   Press Ctrl+C to stop
```

## Usage

```sh
npx lokale <port>
```

| Env | Default |
|-----|---------|
| `LOKALE_SERVER` | `wss://lokale.heydeyo.lol/register` |

## How it works

```
Client                    Cloudflare Worker              Your Server
  │                           │                              │
  ├── WebSocket ──────────────►                              │
  │                           ├── assign random subdomain    │
  │◄── registered + QR ───────┤                              │
  │                           │                              │
  │◄── HTTP request ──────────┤                              │
  ├── forward to localhost ───┼──────────────────────────────►
  │◄── response ──────────────┼──────────────────────────────┤
  ├── send response back ─────►                              │
  │                           ├── return to caller           │
```

Server: Cloudflare Worker + Durable Object (WebSocket Hibernation API). Zero persistence, free-tier friendly.

## Deploy

```sh
cd server
npm install
npx wrangler deploy
```

## License

MIT
