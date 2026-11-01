import { Hono } from "hono";
import { prisma } from "@comata/db";
import { NotebookCreateRequest, NotebookRenameRequest, NotebookSettingsPatch } from "@comata/schema";
import { getSessionUser } from "../session";

type Variables = { userId: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024; // R1: opaque Yjs doc, keep bounded

export const notebookRoutes = new Hono<{ Variables: Variables }>();

// Every notebook route requires a signed-in user.
notebookRoutes.use("*", async (c, next) => {
  const user = await getSessionUser(c);
  if (!user) {
    return c.json({ error: "unauthorized" }, 401);
  }
  c.set("userId", user.id);
  await next();
});

function toSummary(
  notebook: { id: string; title: string; kind: string; background: string; updatedAt: Date },
  role: string,
) {
  return {
    id: notebook.id,
    title: notebook.title,
    kind: notebook.kind,
    background: notebook.background,
    role,
    updatedAt: notebook.updatedAt.toISOString(),
  };
}

/** GET / — notebooks the user is a member of, newest activity first. */
notebookRoutes.get("/", async (c) => {
  const userId = c.get("userId");
  const memberships = await prisma.notebookMember.findMany({
    where: { userId },
    include: { notebook: true },
    orderBy: { notebook: { updatedAt: "desc" } },
  });
  return c.json({
    notebooks: memberships.map((m) => toSummary(m.notebook, m.role)),
  });
});

/** POST / — create a notebook + its OWNER membership (one transaction, rule #1). */
notebookRoutes.post("/", async (c) => {
  const parsed = NotebookCreateRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid request" }, 400);
  }
  const userId = c.get("userId");
  const notebook = await prisma.$transaction(async (tx) => {
    const nb = await tx.notebook.create({
      data: {
        title: parsed.data.title,
        kind: parsed.data.kind,
        background: parsed.data.background,
        ownerId: userId,
      },
    });
    await tx.notebookMember.create({
      data: { notebookId: nb.id, userId, role: "OWNER" },
    });
    return nb;
  });
  return c.json(toSummary(notebook, "OWNER"), 201);
});

/** GET /:id — open a notebook. Invite-link semantics: first open grants EDITOR. */
notebookRoutes.get("/:id", async (c) => {
  const notebookId = c.req.param("id");
  const userId = c.get("userId");
  if (!UUID_RE.test(notebookId)) {
    return c.json({ error: "not found" }, 404);
  }
  const notebook = await prisma.notebook.findUnique({ where: { id: notebookId } });
  if (!notebook) {
    return c.json({ error: "not found" }, 404);
  }
  const existing = await prisma.notebookMember.findUnique({
    where: { notebookId_userId: { notebookId, userId } },
  });
  const membership =
    existing ??
    (await prisma.notebookMember.create({
      data: { notebookId, userId, role: "EDITOR" },
    }));
  return c.json(toSummary(notebook, membership.role));
});

/** PATCH /:id — rename. Requires write access (OWNER or EDITOR). */
notebookRoutes.patch("/:id", async (c) => {
  const notebookId = c.req.param("id");
  const userId = c.get("userId");
  const parsed = NotebookRenameRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid request" }, 400);
  }
  const membership = await prisma.notebookMember.findUnique({
    where: { notebookId_userId: { notebookId, userId } },
  });
  if (!membership || membership.role === "VIEWER") {
    return c.json({ error: "forbidden" }, 403);
  }
  const notebook = await prisma.notebook.update({
    where: { id: notebookId },
    data: { title: parsed.data.title },
  });
  return c.json(toSummary(notebook, membership.role));
});

/** DELETE /:id — OWNER only. Cascades members; runs reaped by FK. */
notebookRoutes.delete("/:id", async (c) => {
  const notebookId = c.req.param("id");
  const userId = c.get("userId");
  const membership = await prisma.notebookMember.findUnique({
    where: { notebookId_userId: { notebookId, userId } },
  });
  if (!membership || membership.role !== "OWNER") {
    return c.json({ error: "forbidden" }, 403);
  }
  await prisma.notebook.delete({ where: { id: notebookId } });
  return c.body(null, 204);
});

/** POST /:id/snapshot — persist the raw Yjs doc (write access required). */
notebookRoutes.post("/:id/snapshot", async (c) => {
  const notebookId = c.req.param("id");
  const userId = c.get("userId");
  const membership = await prisma.notebookMember.findUnique({
    where: { notebookId_userId: { notebookId, userId } },
  });
  if (!membership || membership.role === "VIEWER") {
    return c.json({ error: "forbidden" }, 403);
  }
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength === 0) {
    return c.json({ error: "empty snapshot" }, 400);
  }
  if (bytes.byteLength > MAX_SNAPSHOT_BYTES) {
    return c.json({ error: "snapshot too large" }, 413);
  }
  await prisma.notebook.update({
    where: { id: notebookId },
    data: { yjsSnapshot: bytes },
  });
  return c.json({ ok: true });
});

/** GET /:id/snapshot — fetch the persisted Yjs doc (any member). */
notebookRoutes.get("/:id/snapshot", async (c) => {
  const notebookId = c.req.param("id");
  const userId = c.get("userId");
  const membership = await prisma.notebookMember.findUnique({
    where: { notebookId_userId: { notebookId, userId } },
  });
  if (!membership) {
    return c.json({ error: "forbidden" }, 403);
  }
  const notebook = await prisma.notebook.findUnique({
    where: { id: notebookId },
    select: { yjsSnapshot: true },
  });
  if (!notebook?.yjsSnapshot) {
    return c.body(null, 204);
  }
  return c.body(notebook.yjsSnapshot, 200, {
    "Content-Type": "application/octet-stream",
  });
});

/** GET /:id/settings — notebook settings (any member; viewers read for Run UX). */
notebookRoutes.get("/:id/settings", async (c) => {
  const notebookId = c.req.param("id");
  const userId = c.get("userId");
  const membership = await prisma.notebookMember.findUnique({
    where: { notebookId_userId: { notebookId, userId } },
  });
  if (!membership) {
    return c.json({ error: "forbidden" }, 403);
  }
  const notebook = await prisma.notebook.findUnique({
    where: { id: notebookId },
    select: { allowViewerRuns: true },
  });
  if (!notebook) {
    return c.json({ error: "not found" }, 404);
  }
  return c.json({ allowViewerRuns: notebook.allowViewerRuns });
});

/** PATCH /:id/settings — owner-managed notebook settings (ADR-0003). */
notebookRoutes.patch("/:id/settings", async (c) => {
  const notebookId = c.req.param("id");
  const userId = c.get("userId");
  const parsed = NotebookSettingsPatch.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid request" }, 400);
  }
  const membership = await prisma.notebookMember.findUnique({
    where: { notebookId_userId: { notebookId, userId } },
  });
  if (!membership || membership.role !== "OWNER") {
    return c.json({ error: "forbidden" }, 403);
  }
  const notebook = await prisma.notebook.update({
    where: { id: notebookId },
    data: {
      ...(parsed.data.allowViewerRuns !== undefined ? { allowViewerRuns: parsed.data.allowViewerRuns } : {}),
    },
    select: { allowViewerRuns: true },
  });
  return c.json({ allowViewerRuns: notebook.allowViewerRuns });
});
