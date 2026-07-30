# lokly

Expose localhost to the internet. One command.

```
npx @deyoyk/lokly 3000
```

## How it works

```mermaid
sequenceDiagram
    Browser->>Worker: GET https://abc123-lokly.heydeyo.lol
    Worker->>Client: forward via WebSocket
    Client->>Your Server: localhost:3000
    Your Server->>Client: response
    Client->>Worker: send back
    Worker->>Browser: return to caller
```

## Commands

| | |
|---|---|
| Use | `npx @deyoyk/lokly <port>` |
| Deploy server | `cd server && npm install && npx wrangler deploy` |
| Publish client | `cd client && npm version patch && npm publish --access=public` |

## Env

`LOKLY_SERVER` — default: `wss://lokly.heydeyo.lol/register`

## License

MIT