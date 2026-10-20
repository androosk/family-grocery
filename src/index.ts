export { GroceryList } from "./grocery-list";

export default {
  async fetch(request, env): Promise<Response> {
    // /api/lists/utahjs/ws -> "utahjs"
    const family = new URL(request.url).pathname.match(/^\/api\/lists\/([a-z0-9-]{1,32})\/ws$/)?.[1];
    if (!family || request.headers.get("Upgrade") !== "websocket") {
      return new Response("Not found", { status: 404 });
    }

    // Same name, same object, from anywhere in the world. No provisioning step.
    return env.GROCERY_LIST.getByName(family).fetch(request);
  },
} satisfies ExportedHandler<Env>;
