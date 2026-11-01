import { Hono } from "hono";
import { prisma } from "@comata/db";
import {
  AI_GEN_RATE_LIMIT_PER_HOUR,
  GenerateError,
  GenerateRequest,
  type LibraryEntry,
} from "@comata/schema";
import { generateWidget, GenerationError } from "../gemini";
import { getSessionUser } from "../session";

type Variables = { userId: string; userEmail: string };

// ── AI generation (Slice 5b, ADR-0004) ──────────────────────────────────────
// Server's own key; deny by default via AiAllowlist. Guardrails here:
// allowlist → rate limit (20/h rolling) → schema caps (prompt 2000 chars,
// spec 200KB) → 120s abort. One generation in flight per user.

const HOUR_MS = 3_600_000;
/** userId → timestamps of generations inside the current rolling hour. */
const genBuckets = new Map<string, number[]>();
/** userId → true while a generation is in flight (one per user). */
const inFlight = new Set<string>();

function rateCheck(userId: string): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now();
  const bucket = (genBuckets.get(userId) ?? []).filter((t) => now - t < HOUR_MS);
  if (bucket.length >= AI_GEN_RATE_LIMIT_PER_HOUR) {
    const retryAfter = Math.ceil((HOUR_MS - (now - (bucket[0] as number))) / 1000);
    genBuckets.set(userId, bucket);
    return { ok: false, retryAfter };
  }
  bucket.push(now);
  genBuckets.set(userId, bucket);
  return { ok: true };
}

function genError(
  c: import("hono").Context,
  status: 400 | 401 | 403 | 429 | 502,
  body: GenerateError,
) {
  return c.json(body, status, body.retryAfter !== undefined ? { "Retry-After": String(body.retryAfter) } : undefined);
}

export const aiRoutes = new Hono<{ Variables: Variables }>();

// Every AI route requires a signed-in user; email rides along for the
// allowlist check and admin self-identification.
aiRoutes.use("*", async (c, next) => {
  const user = await getSessionUser(c);
  if (!user) {
    return genError(c, 401, { error: "UNAUTHORIZED", message: "sign in first" });
  }
  c.set("userId", user.id);
  c.set("userEmail", user.email);
  await next();
});

// ── Admin gate (allowlist management is admin-only) ──────────────────────────
// ADMIN_EMAILS in .env — comma-separated list. Deny by default, same posture
// as generation itself: the page is useless without the API behind it.
const adminEmails = (): Set<string> =>
  new Set(
    (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

aiRoutes.use("/allowlist*", async (c, next) => {
  if (!adminEmails().has(c.get("userEmail").toLowerCase())) {
    return genError(c, 403, { error: "FORBIDDEN", message: "admin access required" });
  }
  await next();
});

/** GET /allowlist — entries + whether I'm the allowlisted owner view. */
aiRoutes.get("/allowlist", async (c) => {
  const rows = await prisma.aiAllowlist.findMany({ orderBy: { createdAt: "asc" } });
  return c.json({
    entries: rows.map((r) => ({ id: r.id, email: r.email, createdAt: r.createdAt.toISOString() })),
    me: c.get("userEmail"),
  });
});

/** POST /allowlist — grant access by email (owner convenience; deny by default). */
aiRoutes.post("/allowlist", async (c) => {
  const email = (await c.req.json().catch(() => null) as { email?: string } | null)?.email
    ?.trim()
    .toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return genError(c, 400, { error: "INVALID_REQUEST", message: "valid email required" });
  }
  const entry = await prisma.aiAllowlist.upsert({
    where: { email },
    update: {},
    create: { email, grantedBy: c.get("userId") },
  });
  return c.json({ id: entry.id, email: entry.email, createdAt: entry.createdAt.toISOString() });
});

/** DELETE /allowlist/:id — revoke. */
aiRoutes.delete("/allowlist/:id", async (c) => {
  await prisma.aiAllowlist.delete({ where: { id: c.req.param("id") } }).catch(() => null);
  return c.json({ ok: true });
});

/** GET /library — the user's generated-element library (immutable rows). */
aiRoutes.get("/library", async (c) => {
  const rows = await prisma.generatedElement.findMany({
    where: { userId: c.get("userId") },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const entries: LibraryEntry[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    prompt: r.prompt,
    description: r.description,
    html: r.html,
    specVersion: r.specVersion,
    createdAt: r.createdAt.toISOString(),
  }));
  return c.json({ entries });
});

/** POST /generate — NL prompt → single self-contained HTML (ADR-0004). */
aiRoutes.post("/generate", async (c) => {
  const userId = c.get("userId");
  const email = c.get("userEmail");

  const allowlisted = await prisma.aiAllowlist.findUnique({ where: { email } });
  if (!allowlisted) {
    return genError(c, 403, {
      error: "FORBIDDEN",
      message: "AI Create is invite-only right now — ask the owner for access",
    });
  }

  const parsed = GenerateRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return genError(c, 400, { error: "INVALID_REQUEST", message: "invalid generate request" });
  }
  const req = parsed.data;
  // Edit-prompt needs an instruction; the schema refine already guarantees
  // either prompt (fresh) or baseHtml+instruction (edit) is present.

  const rate = rateCheck(userId);
  if (!rate.ok) {
    return genError(c, 429, {
      error: "RATE_LIMITED",
      message: `rate limit: ${AI_GEN_RATE_LIMIT_PER_HOUR} generations/hour`,
      retryAfter: rate.retryAfter,
    });
  }
  if (inFlight.has(userId)) {
    return genError(c, 429, { error: "RATE_LIMITED", message: "your previous generation is still running" });
  }

  const apiKey = process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) {
    return genError(c, 502, { error: "GENERATION_FAILED", message: "server has no Gemini key configured" });
  }

  inFlight.add(userId);
  try {
    const result = await generateWidget(
      { apiKey },
      req.prompt ?? req.instruction ?? "",
      req.baseHtml && req.instruction ? { baseHtml: req.baseHtml, instruction: req.instruction } : undefined,
    );
    const row = await prisma.generatedElement.create({
      data: {
        userId,
        title: result.title,
        // Edit-prompt generations record the instruction (the user's intent).
        prompt: req.prompt ?? req.instruction ?? "",
        description: result.description,
        html: result.html,
      },
    });
    return c.json({
      title: result.title,
      description: result.description,
      html: result.html,
      libraryId: row.id,
    });
  } catch (err) {
    const message =
      err instanceof GenerationError
        ? err.kind === "timeout"
          ? "generation timed out — try a simpler prompt"
          : `generation failed: ${err.message}`
        : "generation failed";
    return genError(c, 502, { error: "GENERATION_FAILED", message });
  } finally {
    inFlight.delete(userId);
  }
});
