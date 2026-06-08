import { serve } from "@hono/node-server";
import { buildApp } from "./server.js";

const app = buildApp();
const port = Number(process.env.PORT ?? 7200);

serve({ fetch: app.fetch, port }, () => {
  console.log(`[cannon] orchestrator running on http://localhost:${port}`);
});
