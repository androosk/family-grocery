import { evictDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import appSource from "../public/app.js?raw";
import { MAX_ITEMS, type ServerMessage } from "../src/protocol";

type State = Extract<ServerMessage, { type: "state" }>;

/** A unique family per test, since storage is shared across tests. */
function newFamily(): string {
  return `test-${crypto.randomUUID().slice(0, 8)}`;
}

function connect(family: string, name: string): Promise<Response> {
  const url = `http://example.com/api/lists/${family}/ws?name=${encodeURIComponent(name)}`;
  return exports.default.fetch(url, { headers: { Upgrade: "websocket" } });
}

/** A test client that queues incoming messages so tests can wait for a specific one. */
async function join(family: string, name: string) {
  const response = await connect(family, name);
  expect(response.status).toBe(101);
  const ws = response.webSocket;
  if (!ws) throw new Error("No WebSocket on 101 response");

  const inbox: ServerMessage[] = [];
  const waiters: Array<() => void> = [];
  ws.addEventListener("message", (event) => {
    if (event.data === "pong") return;
    inbox.push(JSON.parse(event.data as string) as ServerMessage);
    waiters.splice(0).forEach((wake) => wake());
  });
  ws.accept();

  async function next<T extends ServerMessage>(match: (m: ServerMessage) => m is T): Promise<T>;
  async function next(match: (m: ServerMessage) => boolean): Promise<ServerMessage>;
  async function next(match: (m: ServerMessage) => boolean): Promise<ServerMessage> {
    const deadline = Date.now() + 2000;
    for (;;) {
      const index = inbox.findIndex(match);
      if (index !== -1) return inbox.splice(0, index + 1).at(-1)!;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out. Inbox: ${JSON.stringify(inbox)}`);
      await new Promise<void>((wake) => {
        waiters.push(wake);
        setTimeout(wake, remaining);
      });
    }
  }

  const isState = (m: ServerMessage): m is State => m.type === "state";
  return {
    ws,
    send: (message: unknown) => ws.send(typeof message === "string" ? message : JSON.stringify(message)),
    state: (match: (s: State) => boolean = () => true) => next((m): m is State => isState(m) && match(m)),
    error: () => next((m): m is Extract<ServerMessage, { type: "error" }> => m.type === "error"),
  };
}

describe("Worker routing", () => {
  it("404s for paths that aren't a list socket", async () => {
    const response = await exports.default.fetch("http://example.com/api/nope");
    expect(response.status).toBe(404);
    await response.text();
  });

  it.each(["has space", "under_score", "a".repeat(33), ""])("404s for invalid family name %j", async (family) => {
    const response = await connect(encodeURIComponent(family), "Andrew");
    expect(response.status).toBe(404);
    await response.text();
  });

  it("426s when the request isn't a WebSocket upgrade", async () => {
    const response = await exports.default.fetch(`http://example.com/api/lists/${newFamily()}/ws?name=A`);
    expect(response.status).toBe(426);
    await response.text();
  });

  it.each(["", "   ", "x".repeat(25)])("400s for display name %j", async (name) => {
    const response = await connect(newFamily(), name);
    expect(response.status).toBe(400);
    await response.text();
  });

  it("routes family names case-insensitively to the same object", async () => {
    const family = newFamily();
    const upper = await join(family.toUpperCase(), "Andrew");
    await upper.state();
    upper.send({ type: "add", text: "Milk" });
    await upper.state((s) => s.items.length === 1);

    const lower = await join(family, "Sam");
    const state = await lower.state();
    expect(state.items.map((i) => i.text)).toEqual(["Milk"]);
  });
});

describe("GroceryList", () => {
  it("sends the current state to someone joining", async () => {
    const andrew = await join(newFamily(), "  Andrew  ");
    const state = await andrew.state();
    expect(state).toEqual({ type: "state", items: [], people: ["Andrew"] });
  });

  it("broadcasts adds to everyone in the family, tagged with who added it", async () => {
    const family = newFamily();
    const andrew = await join(family, "Andrew");
    const sam = await join(family, "Sam");
    await andrew.state((s) => s.people.length === 2);

    sam.send({ type: "add", text: "  Bananas  " });

    for (const client of [andrew, sam]) {
      const state = await client.state((s) => s.items.length === 1);
      expect(state.items[0]).toMatchObject({ text: "Bananas", addedBy: "Sam", done: false });
    }
  });

  it("keeps items in the order they were added", async () => {
    const andrew = await join(newFamily(), "Andrew");
    for (const text of ["Eggs", "Bread", "Coffee"]) andrew.send({ type: "add", text });
    const state = await andrew.state((s) => s.items.length === 3);
    expect(state.items.map((i) => i.text)).toEqual(["Eggs", "Bread", "Coffee"]);
  });

  it("toggles an item done and back", async () => {
    const andrew = await join(newFamily(), "Andrew");
    andrew.send({ type: "add", text: "Eggs" });
    const { items } = await andrew.state((s) => s.items.length === 1);
    const id = items[0]!.id;

    andrew.send({ type: "toggle", id });
    await andrew.state((s) => s.items[0]?.done === true);
    andrew.send({ type: "toggle", id });
    await andrew.state((s) => s.items[0]?.done === false);
  });

  it("deletes an item for everyone", async () => {
    const family = newFamily();
    const andrew = await join(family, "Andrew");
    const sam = await join(family, "Sam");
    andrew.send({ type: "add", text: "Eggs" });
    andrew.send({ type: "add", text: "Bread" });
    await andrew.state((s) => s.items.length === 2);
    const { items } = await sam.state((s) => s.items.length === 2);

    sam.send({ type: "delete", id: items[0]!.id });

    for (const client of [andrew, sam]) {
      const state = await client.state((s) => s.items.length === 1);
      expect(state.items[0]!.text).toBe("Bread");
    }
  });

  it("ignores toggles and deletes for items that don't exist", async () => {
    const andrew = await join(newFamily(), "Andrew");
    andrew.send({ type: "add", text: "Eggs" });
    await andrew.state((s) => s.items.length === 1);

    andrew.send({ type: "delete", id: crypto.randomUUID() });
    const state = await andrew.state();
    expect(state.items).toHaveLength(1);
  });

  it.each([
    ["empty text", { type: "add", text: "" }],
    ["whitespace-only text", { type: "add", text: "   " }],
    ["text over 80 characters", { type: "add", text: "x".repeat(81) }],
    ["non-string text", { type: "add", text: 42 }],
    ["unknown message type", { type: "nuke" }],
    ["bad item id", { type: "delete", id: "1 OR 1=1" }],
    ["malformed JSON", "{not json"],
    ["oversized message", JSON.stringify({ type: "add", text: "x".repeat(2000) })],
  ])("rejects %s with an error and no change", async (_label, message) => {
    const andrew = await join(newFamily(), "Andrew");
    await andrew.state();

    andrew.send(message);
    await andrew.error();

    andrew.send({ type: "add", text: "Still works" });
    const state = await andrew.state();
    expect(state.items.map((i) => i.text)).toEqual(["Still works"]);
  });

  it("rejects binary messages", async () => {
    const andrew = await join(newFamily(), "Andrew");
    await andrew.state();
    andrew.ws.send(new Uint8Array([1, 2, 3]));
    await andrew.error();
  });

  it("stores text verbatim; escaping is the renderer's job", async () => {
    const andrew = await join(newFamily(), "Andrew");
    const payload = `<img src=x onerror="alert(1)">`;
    andrew.send({ type: "add", text: payload });
    const state = await andrew.state((s) => s.items.length === 1);
    expect(state.items[0]!.text).toBe(payload);
  });

  it(`caps the list at ${MAX_ITEMS} items`, async () => {
    const andrew = await join(newFamily(), "Andrew");
    for (let i = 0; i < MAX_ITEMS; i++) andrew.send({ type: "add", text: `Item ${i}` });
    await andrew.state((s) => s.items.length === MAX_ITEMS);

    andrew.send({ type: "add", text: "One too many" });
    const error = await andrew.error();
    expect(error.message).toMatch(/full/);
  });

  it("keeps each family's list separate", async () => {
    const tirpoks = await join(newFamily(), "Andrew");
    tirpoks.send({ type: "add", text: "Milk" });
    await tirpoks.state((s) => s.items.length === 1);

    const neighbors = await join(newFamily(), "Sam");
    const state = await neighbors.state();
    expect(state.items).toEqual([]);
  });

  it("updates presence when someone leaves", async () => {
    const family = newFamily();
    const andrew = await join(family, "Andrew");
    const sam = await join(family, "Sam");
    await andrew.state((s) => s.people.length === 2);

    sam.ws.close(1000, "bye");

    const state = await andrew.state((s) => s.people.length === 1);
    expect(state.people).toEqual(["Andrew"]);
  });

  it("keeps the list after everyone leaves and the object is evicted", async () => {
    const family = newFamily();
    const andrew = await join(family, "Andrew");
    andrew.send({ type: "add", text: "Milk" });
    await andrew.state((s) => s.items.length === 1);
    andrew.ws.close(1000, "bye");

    await evictDurableObject(env.GROCERY_LIST.getByName(family), { webSockets: "close" });

    const sam = await join(family, "Sam");
    const state = await sam.state();
    expect(state.items.map((i) => i.text)).toEqual(["Milk"]);
  });

  it("keeps sockets and display names connected through hibernation", async () => {
    const family = newFamily();
    const andrew = await join(family, "Andrew");
    await andrew.state();

    await evictDurableObject(env.GROCERY_LIST.getByName(family));

    andrew.send({ type: "add", text: "Woke up" });
    const state = await andrew.state((s) => s.items.length === 1);
    expect(state.items[0]!.addedBy).toBe("Andrew");
    expect(state.people).toEqual(["Andrew"]);
  });

  it("answers keepalive pings", async () => {
    const andrew = await join(newFamily(), "Andrew");
    await andrew.state();
    const pong = new Promise<string>((resolve) =>
      andrew.ws.addEventListener("message", (event) => {
        if (event.data === "pong") resolve(event.data);
      }),
    );
    andrew.ws.send("ping");
    expect(await pong).toBe("pong");
  });
});

describe("client", () => {
  it("never renders user text as HTML", () => {
    expect(appSource).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});
