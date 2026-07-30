# lokly

Instant HTTP tunnels for local servers.

```
npx @deyoyk/lokly 3000

```

```
Connecting to wss://lokly.heydeyo.lol/register ...

Tunnel active!
   Public URL: https://abc123-lokly.heydeyo.lol
   [QR code]

   Forwarding localhost:3000 -> https://abc123-lokly.heydeyo.lol
   Press Ctrl+C to stop
```

## Usage

```sh
npx @deyoyk/lokly <port>
```

| Env | Default |
|-----|---------|
| `LOKLY_SERVER` | `wss://lokly.heydeyo.lol/register` |
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

## Publish

```sh
cd client
npm version patch
npm publish --access=public
```

## License

MIT
