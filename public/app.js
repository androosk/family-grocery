// @ts-check
// No framework, no build step. The Durable Object is the source of truth:
// we send intents, it broadcasts the whole list back, we re-render.

/** @typedef {import("../src/protocol").ClientMessage} ClientMessage */
/** @typedef {import("../src/protocol").ServerMessage} ServerMessage */
/** @typedef {import("../src/protocol").Item} Item */

const DEFAULT_FAMILY = "utahjs";
const NAME_KEY = "grocery:name";
const KEEPALIVE_MS = 20_000;

/**
 * @template {HTMLElement} T
 * @param {string} id
 * @param {new () => T} type
 * @returns {T}
 */
function byId(id, type) {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`Missing #${id}`);
  return element;
}

const ui = {
  family: byId("family", HTMLHeadingElement),
  presence: byId("presence", HTMLSpanElement),
  joinForm: byId("join", HTMLFormElement),
  nameInput: byId("name", HTMLInputElement),
  list: byId("list", HTMLElement),
  addForm: byId("add", HTMLFormElement),
  itemInput: byId("item", HTMLInputElement),
  error: byId("error", HTMLParagraphElement),
  items: byId("items", HTMLUListElement),
  empty: byId("empty", HTMLParagraphElement),
  me: byId("me", HTMLElement),
  rename: byId("rename", HTMLButtonElement),
  joinUrl: byId("join-url", HTMLElement),
};

/** "/UtahJS Family!" -> "utahjs-family". Must match the Worker's route pattern. */
function familyFromPath() {
  let path = location.pathname.slice(1);
  try {
    path = decodeURIComponent(path);
  } catch {
    // Malformed escape sequence; normalize the raw path instead.
  }
  return (
    path
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || DEFAULT_FAMILY
  );
}

const family = familyFromPath();
if (location.pathname !== `/${family}`) history.replaceState(null, "", `/${family}`);
document.title = `${family} · Grocery list`;
ui.family.textContent = family;
ui.joinUrl.textContent = `${location.host}/${family}`;

// ---- Connection -----------------------------------------------------------

/** @type {WebSocket | null} */
let socket = null;
let attempt = 0;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let retryTimer;
/** @type {Item[]} */
let lastItems = [];

/** Close the current socket on purpose; its close handler won't try to reconnect. */
function disconnect() {
  clearTimeout(retryTimer);
  const current = socket;
  socket = null;
  current?.close(1000);
}

/** @param {string} name */
function connect(name) {
  disconnect();
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(
    `${protocol}://${location.host}/api/lists/${family}/ws?name=${encodeURIComponent(name)}`,
  );
  socket = ws;

  ws.addEventListener("open", () => {
    attempt = 0;
    document.body.classList.add("live");
  });

  ws.addEventListener("message", (event) => {
    if (event.data === "pong") return;
    /** @type {ServerMessage} */
    const message = JSON.parse(event.data);
    if (message.type === "state") render(message.items, message.people);
    else showError(message.message);
  });

  ws.addEventListener("close", () => {
    if (socket !== ws) return; // Closed on purpose, not a dropped connection.
    document.body.classList.remove("live");
    ui.presence.textContent = "Reconnecting…";
    retryTimer = setTimeout(() => connect(name), Math.min(500 * 2 ** attempt++, 8000));
  });
}

/** @param {ClientMessage} message */
function send(message) {
  if (socket?.readyState !== WebSocket.OPEN) {
    showError("Reconnecting… try again in a second.");
    render(lastItems); // Undo any checkbox the browser already flipped.
    return;
  }
  socket.send(JSON.stringify(message));
}

// Phones drop idle sockets; the Durable Object answers "ping" without waking up.
setInterval(() => {
  if (socket?.readyState === WebSocket.OPEN) socket.send("ping");
}, KEEPALIVE_MS);

// Coming back to a backgrounded tab: reconnect now instead of waiting on backoff.
document.addEventListener("visibilitychange", () => {
  const name = savedName();
  if (document.visibilityState !== "visible" || !name) return;
  if (!socket || socket.readyState >= WebSocket.CLOSING) {
    attempt = 0;
    connect(name);
  }
});

// ---- Rendering -------------------------------------------------------------
// Everything from the server is set with textContent. The audience is full of
// developers; someone will try <img onerror>.

/**
 * @param {Item[]} items
 * @param {string[]} [people]
 */
function render(items, people) {
  lastItems = items;
  ui.items.replaceChildren(...items.map(renderItem));
  ui.empty.hidden = items.length > 0;
  if (people) ui.presence.textContent = describePresence(people);
}

/** @param {Item} item */
function renderItem(item) {
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = item.done;
  checkbox.addEventListener("change", () => send({ type: "toggle", id: item.id }));

  const text = document.createElement("span");
  text.className = "text";
  text.textContent = item.text;

  const addedBy = document.createElement("span");
  addedBy.className = "by";
  addedBy.textContent = item.addedBy;

  const label = document.createElement("label");
  label.append(checkbox, text, addedBy);

  const remove = document.createElement("button");
  remove.className = "delete";
  remove.type = "button";
  remove.textContent = "×";
  remove.setAttribute("aria-label", `Delete ${item.text}`);
  remove.addEventListener("click", () => send({ type: "delete", id: item.id }));

  const li = document.createElement("li");
  li.classList.toggle("done", item.done);
  li.append(label, remove);
  return li;
}

/** @param {string[]} people */
function describePresence(people) {
  const names = [...new Set(people)].sort((a, b) => a.localeCompare(b));
  const shown = names.slice(0, 4).join(", ");
  const more = names.length > 4 ? ` +${names.length - 4} more` : "";
  return `${people.length} connected · ${shown}${more}`;
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let errorTimer;
/** @param {string} message */
function showError(message) {
  ui.error.textContent = message;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => (ui.error.textContent = ""), 4000);
}

// ---- Joining ---------------------------------------------------------------

function savedName() {
  try {
    return localStorage.getItem(NAME_KEY)?.trim() || null;
  } catch {
    return null; // Private mode or blocked storage: ask every time.
  }
}

/** @param {string} name */
function start(name) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Not fatal; the name just won't be remembered.
  }
  ui.me.textContent = name;
  ui.joinForm.hidden = true;
  ui.list.hidden = false;
  connect(name);
  ui.itemInput.focus();
}

ui.joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = ui.nameInput.value.trim();
  if (name) start(name);
});

ui.addForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = ui.itemInput.value.trim();
  if (!text) return;
  send({ type: "add", text });
  ui.itemInput.value = "";
});

ui.rename.addEventListener("click", () => {
  disconnect();
  document.body.classList.remove("live");
  ui.presence.textContent = "Pick a name to join";
  ui.list.hidden = true;
  ui.joinForm.hidden = false;
  ui.nameInput.value = savedName() ?? "";
  ui.nameInput.focus();
});

const name = savedName();
if (name) {
  start(name);
} else {
  ui.joinForm.hidden = false;
  ui.presence.textContent = "Pick a name to join";
  ui.nameInput.focus();
}
