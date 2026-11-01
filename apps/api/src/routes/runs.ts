import { Hono } from "hono";
import { prisma } from "@comata/db";
import {
  CodeRunRequest,
  RUN_RATE_LIMIT_PER_MIN,
  type CodeRunError,
  type CodeRunResult,
} from "@comata/schema";
import { RunnerError, type Runner } from "@comata/runner";
import { getSessionUser } from "../session";
import { runner } from "../runner-instance";

type Variables = { userId: string };

// ── Per-user, in-memory guards (ADR-0002) ────────────────────────────────────
// Ephemeral by nature; lost on redeploy is harmless. Valkey re-enters only if
// the API ever runs multi-instance.

const RATE_WINDOW_MS = 60_000;

/** userId → timestamps of runs inside the current window. */
const rateBuckets = new Map<string, number[]>();
/** userId → notebookId of the in-flight run (run lock, notebook-wide). */
const running = new Map<string, string>();

function rateCheck(userId: string): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now();
  const bucket = (rateBuckets.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (bucket.length >= RUN_RATE_LIMIT_PER_MIN) {
    const retryAfter = Math.ceil((RATE_WINDOW_MS - (now - (bucket[0] as number))) / 1000);
    rateBuckets.set(userId, bucket);
    return { ok: false, retryAfter: Math.max(1, retryAfter) };
  }
  bucket.push(now);
  rateBuckets.set(userId, bucket);
  return { ok: true };
}

function runError(c: import("hono").Context, status: 400 | 401 | 403 | 409 | 429 | 502 | 503, body: CodeRunError) {
  return c.json(body, status, body.retryAfter !== undefined ? { "Retry-After": String(body.retryAfter) } : undefined);
}

export const runRoutes = new Hono<{ Variables: Variables }>();

// Every run requires a signed-in user (Better-Auth session).
runRoutes.use("*", async (c, next) => {
  const user = await getSessionUser(c);
  if (!user) {
    return runError(c, 401, { error: "FORBIDDEN", message: "sign in to run code" });
  }
  c.set("userId", user.id);
  await next();
});

/** GET /runtimes — what the runner can execute (drives the language selector). */
runRoutes.get("/runtimes", async (c) => {
  try {
    return c.json({ runtimes: await (runner as Runner).runtimes() });
  } catch (err) {
    const kind = err instanceof RunnerError ? err.kind : "failed";
    return runError(c, 503, {
      error: "RUNNER_OFFLINE",
      message: kind === "offline" ? "code runner is offline" : String(err),
    });
  }
});

/** POST / — run one code element's source synchronously (ADR-0002). */
runRoutes.post("/", async (c) => {
  const userId = c.get("userId");
  const parsed = CodeRunRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return runError(c, 400, { error: "INVALID_REQUEST", message: "invalid run request" });
  }
  const req = parsed.data;
  const notebookId = c.req.query("notebookId") ?? "";
  if (!notebookId) {
    return runError(c, 400, { error: "INVALID_REQUEST", message: "notebookId is required" });
  }

  const membership = await prisma.notebookMember.findUnique({
    where: { notebookId_userId: { notebookId, userId } },
  });
  if (!membership) {
    return runError(c, 403, { error: "FORBIDDEN", message: "not a member of this notebook" });
  }
  if (membership.role === "VIEWER") {
    const nb = await prisma.notebook.findUnique({
      where: { id: notebookId },
      select: { allowViewerRuns: true },
    });
    if (!nb?.allowViewerRuns) {
      return runError(c, 403, { error: "FORBIDDEN", message: "viewers can't run code in this notebook" });
    }
  }

  // One in-flight run per user, notebook-wide (run lock).
  if (running.has(userId)) {
    return runError(c, 409, { error: "ALREADY_RUNNING", message: "your previous run is still executing" });
  }

  const rate = rateCheck(userId);
  if (!rate.ok) {
    return runError(c, 429, {
      error: "RATE_LIMITED",
      message: `rate limit: ${RUN_RATE_LIMIT_PER_MIN} runs/min`,
      retryAfter: rate.retryAfter,
    });
  }

  running.set(userId, notebookId);
  try {
    const result: CodeRunResult = await runner.run({
      language: req.language,
      code: req.code,
      stdin: req.stdin,
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof RunnerError && err.kind === "offline") {
      return runError(c, 503, { error: "RUNNER_OFFLINE", message: "code runner is offline" });
    }
    return runError(c, 502, { error: "RUN_FAILED", message: String(err instanceof Error ? err.message : err) });
  } finally {
    running.delete(userId);
  }
});
