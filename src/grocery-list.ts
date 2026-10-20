import { DurableObject } from "cloudflare:workers";
import {
  ClientMessage,
  DisplayName,
  MAX_ITEMS,
  type Item,
  type ServerMessage,
} from "./protocol";

// Per-connection data that survives hibernation.
type Attachment = { name: string };

type ItemRow = {
  id: string;
  text: string;
  added_by: string;
  done: number;
  created_at: number;
};

const MAX_MESSAGE_LENGTH = 1024;

/** One instance per family. Every phone in the family talks to this same object. */
export class GroceryList extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Runs every time the object wakes up. This SQLite database lives inside the object.
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id         TEXT PRIMARY KEY,
        text       TEXT NOT NULL,
        added_by   TEXT NOT NULL,
        done       INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )
    `);
    // Keepalive pings get answered without waking the object (or billing for it).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const name = DisplayName.safeParse(new URL(request.url).searchParams.get("name"));
    if (!name.success) {
      return new Response("A display name (1-24 characters) is required", { status: 400 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    // acceptWebSocket (instead of server.accept()) lets the object hibernate
    // between messages while every socket stays connected.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ name: name.data } satisfies Attachment);
    this.broadcastState();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > MAX_MESSAGE_LENGTH) {
      return this.sendError(ws, "Unsupported message");
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return this.sendError(ws, "Invalid JSON");
    }
    const parsed = ClientMessage.safeParse(json);
    if (!parsed.success) {
      return this.sendError(ws, "Invalid message");
    }

    const message = parsed.data;
    const sql = this.ctx.storage.sql;
    switch (message.type) {
      case "add": {
        const { count } = sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM items").one();
        if (count >= MAX_ITEMS) {
          return this.sendError(ws, `The list is full (${MAX_ITEMS} items)`);
        }
        const { name } = ws.deserializeAttachment() as Attachment;
        sql.exec(
          "INSERT INTO items (id, text, added_by, created_at) VALUES (?, ?, ?, ?)",
          crypto.randomUUID(),
          message.text,
          name,
          Date.now(),
        );
        break;
      }
      case "toggle":
        sql.exec("UPDATE items SET done = 1 - done WHERE id = ?", message.id);
        break;
      case "delete":
        sql.exec("DELETE FROM items WHERE id = ?", message.id);
        break;
    }
    this.broadcastState();
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    // The runtime replies to the close frame for us (compat date >= 2026-04-07).
    this.broadcastState(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.broadcastState(ws);
  }

  private items(): Item[] {
    return this.ctx.storage.sql
      .exec<ItemRow>("SELECT * FROM items ORDER BY created_at, rowid")
      .toArray()
      .map((row) => ({
        id: row.id,
        text: row.text,
        addedBy: row.added_by,
        done: row.done === 1,
        createdAt: row.created_at,
      }));
  }

  /** No diffing, no CRDTs: the object is the source of truth, so everyone gets the whole list. */
  private broadcastState(leaving?: WebSocket): void {
    const sockets = this.ctx.getWebSockets().filter((ws) => ws !== leaving);
    const people = sockets.map((ws) => (ws.deserializeAttachment() as Attachment).name);
    const state = JSON.stringify({
      type: "state",
      items: this.items(),
      people,
    } satisfies ServerMessage);

    for (const ws of sockets) {
      try {
        ws.send(state);
      } catch {
        // Socket is already closing; its webSocketClose will rebroadcast.
      }
    }
  }

  private sendError(ws: WebSocket, message: string): void {
    ws.send(JSON.stringify({ type: "error", message } satisfies ServerMessage));
  }
}
