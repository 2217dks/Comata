import { Hono } from "hono";
import { cors } from "hono/cors";
import { Liveblocks } from "@liveblocks/node";
import { APP_NAME, HealthResponse, LiveblocksAuthRequest } from "@comata/schema";
import { prisma } from "@comata/db";
import { auth, WEB_ORIGINS } from "./auth";
import { getSessionUser } from "./session";
import { notebookRoutes } from "./routes/notebooks";
import { runRoutes } from "./routes/runs";
import { aiRoutes } from "./routes/ai";

export const API_VERSION = "0.3.0";

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

// MVP posture: cookies must ride along for Better-Auth sessions.
app.use(
  "*",
  cors({
    origin: [...WEB_ORIGINS],
    credentials: true,
  }),
);

app.get("/health", (c) => c.json(health));

// ── Better-Auth (Slice 2): sign-up / sign-in / sign-out / session ───────────
app.on(["POST", "GET"], "/auth/**", (c) => auth.handler(c.req.raw));

// ── Notebooks (Slice 2): CRUD + snapshots + settings, membership-enforced ───
app.route("/notebooks", notebookRoutes);

// ── Code runs (Slice 4): per-user, ephemeral, sync Piston (ADR-0002/0003) ───
app.route("/runs", runRoutes);

// ── AI generation (Slice 5b): allowlist-gated, server's own key (ADR-0004) ──
app.route("/ai", aiRoutes);

// ── Liveblocks room auth (Slice 2: signed-in members only) ──────────────────
// Room ids follow `notebook:{Notebook.id}`; roles map to scopes (rule #2):
//   OWNER/EDITOR → room:write, VIEWER → room:read.

let liveblocks: Liveblocks | null = null;

function getLiveblocks(): Liveblocks {
  if (liveblocks === null) {
    liveblocks = new Liveblocks({ secret: process.env.LIVEBLOCKS_SECRET_KEY ?? "" });
  }
  return liveblocks;
}

const NOTEBOOK_ROOM_RE = /^notebook:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

app.post("/liveblocks/auth", async (c) => {
  const user = await getSessionUser(c);
  if (!user) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const parsed = LiveblocksAuthRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid request" }, 400);
  }

  const match = NOTEBOOK_ROOM_RE.exec(parsed.data.room);
  const notebookId = match?.[1];
  if (!notebookId) {
    return c.json({ error: "invalid room" }, 400);
  }

  const membership = await prisma.notebookMember.findUnique({
    where: { notebookId_userId: { notebookId, userId: user.id } },
  });
  if (!membership) {
    return c.json({ error: "forbidden" }, 403);
  }

  const scopes: readonly ("room:write" | "room:read")[] =
    membership.role === "VIEWER" ? ["room:read"] : ["room:write"];

  try {
    const session = getLiveblocks().prepareSession(user.id, {
      userInfo: {
        name: user.name || user.email,
        avatar: user.image ?? "",
      },
    });
    session.allow(parsed.data.room, scopes);
    const { status, body } = await session.authorize();
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("liveblocks auth failed:", err);
    return c.json({ error: "liveblocks auth failed" }, 500);
  }
});

export default app;
