// The whole client: send what the user did, render whatever the Durable Object sends back.

const $ = (selector) => document.querySelector(selector);

// The URL path is the family: /utahjs, /tirpoks, ... (default: utahjs)
const family = location.pathname.slice(1).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32) || "utahjs";
history.replaceState(null, "", `/${family}`);
$("#family").textContent = family;
$("#join-url").textContent = `${location.host}/${family}`;

let socket;

function connect(name) {
  const url = `${location.origin.replace("http", "ws")}/api/lists/${family}/ws?name=${encodeURIComponent(name)}`;
  socket = new WebSocket(url);
  socket.onmessage = (event) => render(JSON.parse(event.data));
  // Dropped (bad signal, or a redeploy)? Try again in a second.
  socket.onclose = () => {
    $("#presence").textContent = "Reconnecting…";
    setTimeout(() => connect(name), 1000);
  };
}

/** Returns false if we're mid-reconnect and the message didn't go out. */
function send(message) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function render({ items, people }) {
  $("#presence").textContent = `${people.length} connected: ${people.join(", ")}`;
  $("#items").replaceChildren(...items.map(renderItem));
}

// Only ever textContent, never innerHTML: the audience will try <img onerror>.
function renderItem(item) {
  const done = item.done === 1; // SQLite has no booleans

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = done;
  checkbox.onchange = () => send({ type: "check", id: item.id, done: checkbox.checked });

  const text = document.createElement("span");
  text.textContent = item.text;

  const addedBy = document.createElement("small");
  addedBy.textContent = item.added_by;

  const label = document.createElement("label");
  label.append(checkbox, text, addedBy);

  const remove = document.createElement("button");
  remove.textContent = "×";
  remove.ariaLabel = `Delete ${item.text}`;
  remove.onclick = () => send({ type: "delete", id: item.id });

  const li = document.createElement("li");
  li.classList.toggle("done", done);
  li.append(label, remove);
  return li;
}

function start(name) {
  $("#join").hidden = true;
  $("#add").hidden = false;
  connect(name);
}

$("#join").onsubmit = (event) => {
  event.preventDefault();
  const name = $("#name").value.trim();
  if (!name) return;
  localStorage.setItem("name", name);
  start(name);
};

$("#add").onsubmit = (event) => {
  event.preventDefault();
  if (send({ type: "add", text: $("#item").value })) $("#item").value = "";
};

const savedName = localStorage.getItem("name");
if (savedName) start(savedName);
else $("#join").hidden = false;
