import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

// What a phone is allowed to send. Anything else gets ignored.
const Message = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add"), text: z.string().trim().min(1).max(80) }),
  // "check" says what the box should be, not "flip it", so two people tapping at once agree.
  z.object({ type: z.literal("check"), id: z.string(), done: z.boolean() }),
  z.object({ type: z.literal("delete"), id: z.string() }),
]);
const Name = z.string().trim().min(1).max(24);
const MAX_ITEMS = 100;

/** One instance per family. Every phone in the family talks to this same object. */
export class GroceryList extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // This SQLite database lives inside the object, next to the code.
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id       TEXT PRIMARY KEY,
        text     TEXT NOT NULL,
        added_by TEXT NOT NULL,
        done     INTEGER NOT NULL DEFAULT 0
      )
    `);
  }

  // A phone connects.
  async fetch(request: Request): Promise<Response> {
    const name = Name.safeParse(new URL(request.url).searchParams.get("name"));
    if (!name.success) return new Response("Name required", { status: 400 });

    const { 0: client, 1: server } = new WebSocketPair();
    // acceptWebSocket (instead of server.accept()) lets the object sleep
    // between messages while every phone stays connected.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(name.data); // Survives that sleep, too.
    this.broadcast();

    return new Response(null, { status: 101, webSocket: client });
  }

  // A phone sends something.
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const message = parse(raw);
    if (!message) return;

    const sql = this.ctx.storage.sql;
    if (message.type === "add") {
      const { count } = sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM items").one();
      if (count >= MAX_ITEMS) return;
      sql.exec(
        "INSERT INTO items (id, text, added_by) VALUES (?, ?, ?)",
        crypto.randomUUID(),
        message.text,
        ws.deserializeAttachment(),
      );
    }
    if (message.type === "check") sql.exec("UPDATE items SET done = ? WHERE id = ?", message.done ? 1 : 0, message.id);
    if (message.type === "delete") sql.exec("DELETE FROM items WHERE id = ?", message.id);

    this.broadcast();
  }

  // A phone leaves (closed the tab, lost signal, or we redeployed).
  async webSocketClose(ws: WebSocket): Promise<void> {
    this.broadcast(ws);
  }

  /** Send the whole list, plus who's here, to every connected phone. No diffing needed. */
  broadcast(leaving?: WebSocket): void {
    // During webSocketClose, the leaving socket is still in getWebSockets(). Skip it.
    const sockets = this.ctx.getWebSockets().filter((ws) => ws !== leaving);
    const state = JSON.stringify({
      items: this.ctx.storage.sql.exec("SELECT * FROM items ORDER BY rowid").toArray(),
      people: sockets.map((ws) => ws.deserializeAttachment()),
    });
    for (const ws of sockets) {
      try {
        ws.send(state);
      } catch {
        // That phone is mid-disconnect; its webSocketClose will rebroadcast.
      }
    }
  }
}

/** The parsed message if it's valid, otherwise null. */
function parse(raw: string | ArrayBuffer) {
  if (typeof raw !== "string" || raw.length > 1000) return null;
  try {
    return Message.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
