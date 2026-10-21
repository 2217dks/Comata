import { Hono } from "hono";
import { cors } from "hono/cors";
import { APP_NAME, HealthResponse } from "@comata/schema";

export const API_VERSION = "0.1.0";

const health = HealthResponse.parse({
  ok: true,
  service: `${APP_NAME.toLowerCase()}-api`,
  version: API_VERSION,
  time: new Date().toISOString(),
});

/**
 * The Hono app. Base path `/v1` — all routes live under it.
 * Transport-agnostic: mounted by src/server.ts (local Node) and api/index.ts (Vercel).
 */
const app = new Hono().basePath("/v1");

// MVP posture: permissive CORS (the SPA and API are same-product deployments).
// Tighten origins when auth lands in Slice 2.
app.use("*", cors());

app.get("/health", (c) => c.json(health));

export default app;
