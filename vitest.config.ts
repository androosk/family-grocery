import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  // WebSockets + Durable Objects need shared storage (Cloudflare known issue), so
  // tests run in one worker and each test uses its own family name instead.
  test: { maxWorkers: 1, isolate: false },
});
