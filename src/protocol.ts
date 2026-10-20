import { z } from "zod";

// Everything that crosses the WebSocket. The audience is untrusted input, so the
// server validates every message and the client renders text with textContent only.

export const MAX_ITEMS = 100;
export const MAX_ITEM_LENGTH = 80;
export const MAX_NAME_LENGTH = 24;

export const DisplayName = z.string().trim().min(1).max(MAX_NAME_LENGTH);

export const ClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add"), text: z.string().trim().min(1).max(MAX_ITEM_LENGTH) }),
  z.object({ type: z.literal("toggle"), id: z.uuid() }),
  z.object({ type: z.literal("delete"), id: z.uuid() }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export type Item = {
  id: string;
  text: string;
  addedBy: string;
  done: boolean;
  createdAt: number;
};

export type ServerMessage =
  | { type: "state"; items: Item[]; people: string[] }
  | { type: "error"; message: string };
