# Family Grocery List

A real-time shared grocery list built on [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/). It's the demo for **"Memory for Serverless: Exploring Cloudflare Durable Objects"** at UtahJS (October 2026).

Scan the QR code, pick a name, and you've joined the family. Everyone's adds, check-offs, and deletes show up on every phone instantly.

## How it works

```
phone ──┐
phone ──┼─ WebSocket ─▶ Worker ─ getByName("utahjs") ─▶ GroceryList Durable Object
phone ──┘                                                 ├─ SQLite (the list)
                                                          └─ every connected socket
```

- **One object per family.** `env.GROCERY_LIST.getByName(family)` routes every client, from anywhere, to the same instance. A new name means a new, empty list, with nothing to provision.
- **State lives in the object.** Items are stored in the object's own SQLite database and survive restarts, evictions, and deploys.
- **WebSocket Hibernation.** `ctx.acceptWebSocket()` keeps sockets open while the object sleeps between messages. Display names ride along in `serializeAttachment()`, and keepalive pings get an auto-response without waking the object.
- **No diffing.** Each object runs one request at a time, so every change is applied in order and the full list is broadcast to everyone.

| File | What's in it |
|---|---|
| `src/index.ts` | Worker: routes `/api/lists/:family/ws` to the right object |
| `src/grocery-list.ts` | The Durable Object: SQLite, WebSockets, broadcast |
| `src/protocol.ts` | Zod schemas for every client message, plus limits |
| `public/` | Plain HTML/CSS/JS client (`// @ts-check`, no build step) |

Guardrails for a room full of developers:

- Every client message is validated with Zod.
- Items max out at 80 characters, names at 24, and the list at 100 items.
- The client renders text with `textContent` only. A test fails if `innerHTML` ever shows up.

## Commands

```sh
npm install
npm run dev        # http://localhost:8787/utahjs
npm test           # Vitest inside workerd (@cloudflare/vitest-plugin)
npm run typecheck  # Worker, client, and tests
npm run deploy     # needs `npx wrangler login` first
```

After the event, `npx wrangler delete` removes the Worker and its data.

## Demo moments

- **New object on demand.** Change the URL from `/utahjs` to `/anything-else` and you get a separate list instantly.
- **Memory survives a deploy.** Run `npm run deploy` mid-talk. Phones drop, reconnect on their own, and the list is still there.
