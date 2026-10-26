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

- **One object per family.** `getByName(family)` routes every phone, from anywhere, to the same instance. A new name gets a new, empty list, with nothing to provision.
- **State lives in the object.** Items are stored in the object's own SQLite database and survive restarts and deploys.
- **WebSocket Hibernation.** `ctx.acceptWebSocket()` keeps phones connected while the object sleeps between messages. Each phone's display name rides along via `serializeAttachment()`.
- **No diffing.** Each object runs one request at a time, so after every change it broadcasts the whole list to everyone.

| File | What's in it |
|---|---|
| `src/index.ts` | Worker: routes `/api/lists/:family/ws` to that family's object |
| `src/grocery-list.ts` | The Durable Object: SQLite, WebSockets, broadcast |
| `public/` | Plain HTML/CSS/JS client, no build step |

## Commands

```sh
npm install
npm run dev        # http://localhost:8787/utahjs
npm run deploy     # run `npx wrangler login` once first
```
Link to slide show here: [State for Serverless](https://docs.google.com/presentation/d/1XswLKlaeax_rlbx3M3d4bnVCesBBv37TgLXQocdcvlc/edit?usp=sharing)

## Demo moments

- **New object on demand.** Change `/utahjs` in the URL to `/anything-else` and you get a separate list instantly.
- **Memory survives a deploy.** Run `npm run deploy` mid-talk. Phones drop, reconnect a second later, and the list is still there.
