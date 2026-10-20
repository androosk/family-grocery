export { GroceryList } from "./grocery-list";

const LIST_SOCKET = /^\/api\/lists\/([a-z0-9-]{1,32})\/ws$/i;

export default {
  async fetch(request, env): Promise<Response> {
    const match = new URL(request.url).pathname.match(LIST_SOCKET);
    if (!match?.[1]) {
      return new Response("Not found", { status: 404 });
    }

    // Same name, same object, from anywhere in the world. No provisioning step.
    const list = env.GROCERY_LIST.getByName(match[1].toLowerCase());
    return list.fetch(request);
  },
} satisfies ExportedHandler<Env>;
