import { z } from "zod";

// ── App constants ────────────────────────────────────────────────────────────

export const APP_NAME = "Comata";

/** Element kinds — the RFC-001-style uniform element system (Slice 1+). */
export const ELEMENT_KINDS = ["ink", "shape", "text", "code", "math"] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];

// ── Notebook domain (Slice 2 — models per docs/data-model.md) ───────────────

export const NotebookKind = z.enum(["canvas", "presentation"]);
export type NotebookKind = z.infer<typeof NotebookKind>;

/** Canvas-notebook surface tone: chosen at creation, immutable afterward
 * (Slice 7). Presentation notebooks don't use this — their pages carry
 * per-page background colors in the doc. */
export const NotebookBackground = z.enum(["light", "dark"]);
export type NotebookBackground = z.infer<typeof NotebookBackground>;

export const MemberRole = z.enum(["OWNER", "EDITOR", "VIEWER"]);
export type MemberRole = z.infer<typeof MemberRole>;

// ── API contracts (Slice 0 — walking skeleton) ──────────────────────────────

export const HealthResponse = z.object({
  ok: z.boolean(),
  service: z.string(),
  version: z.string(),
  time: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

// ── Liveblocks room auth (Slice 1) ──────────────────────────────────────────

export const LiveblocksAuthRequest = z.object({
  room: z.string().min(1).max(120),
  userId: z.string().min(1).max(64).optional(),
});
export type LiveblocksAuthRequest = z.infer<typeof LiveblocksAuthRequest>;

export const LiveblocksAuthResponse = z.object({
  token: z.string(),
});
export type LiveblocksAuthResponse = z.infer<typeof LiveblocksAuthResponse>;

// ── Notebook API contracts (Slice 2) ────────────────────────────────────────

export const NotebookCreateRequest = z.object({
  title: z.string().min(1).max(120),
  kind: NotebookKind.default("canvas"),
  /** Canvas notebooks only: surface tone, fixed at creation (Slice 7). */
  background: NotebookBackground.default("dark"),
});
export type NotebookCreateRequest = z.infer<typeof NotebookCreateRequest>;

export const NotebookRenameRequest = z.object({
  title: z.string().min(1).max(120),
});
export type NotebookRenameRequest = z.infer<typeof NotebookRenameRequest>;

export const NotebookSummary = z.object({
  id: z.string().uuid(),
  title: z.string(),
  kind: NotebookKind,
  /** Canvas notebooks: surface tone. Presentation notebooks: "dark" (unused —
   * pages carry their own backgrounds in the doc). */
  background: NotebookBackground.default("dark"),
  role: MemberRole,
  updatedAt: z.string(),
});
export type NotebookSummary = z.infer<typeof NotebookSummary>;

export const NotebookListResponse = z.object({
  notebooks: z.array(NotebookSummary),
});
export type NotebookListResponse = z.infer<typeof NotebookListResponse>;

// ── Notebook settings (Slice 4 — owner-managed share controls) ───────────────

export const NotebookSettingsPatch = z.object({
  allowViewerRuns: z.boolean().optional(),
});
export type NotebookSettingsPatch = z.infer<typeof NotebookSettingsPatch>;

export const NotebookSettings = z.object({
  allowViewerRuns: z.boolean(),
});
export type NotebookSettings = z.infer<typeof NotebookSettings>;

// ── Code run contracts (Slice 4 — per-user ephemeral runs, ADR-0002/0003) ────

export const RUN_RATE_LIMIT_PER_MIN = 5;
/** Global run caps (MVP constants; per-language tables are a production concern). */
export const RUN_WALL_TIME_LIMIT_S = 10;
export const RUN_MEMORY_LIMIT_MB = 512;

export const CodeRunRequest = z.object({
  elementId: z.string().min(1).max(64),
  filename: z.string().min(1).max(120),
  language: z.string().min(1).max(40),
  code: z.string().max(100_000),
  stdin: z.string().max(10_000).default(""),
});
export type CodeRunRequest = z.infer<typeof CodeRunRequest>;

export const CodeRunResult = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().nullable(),
  timeMs: z.number().nullable(),
});
export type CodeRunResult = z.infer<typeof CodeRunResult>;

/** Structured error bodies — the client switches on `code` for button states. */
export const RunErrorCode = z.enum([
  "RATE_LIMITED",
  "ALREADY_RUNNING",
  "FORBIDDEN",
  "RUNNER_OFFLINE",
  "RUN_FAILED",
  "INVALID_REQUEST",
]);
export type RunErrorCode = z.infer<typeof RunErrorCode>;

export const CodeRunError = z.object({
  error: RunErrorCode,
  message: z.string(),
  retryAfter: z.number().optional(),
});
export type CodeRunError = z.infer<typeof CodeRunError>;

// ── AI generation (Slice 5b, ADR-0004) ──────────────────────────────────────
// Server's own Gemini key, allowlist-gated, deny by default. Guardrails are
// server-enforced constants; the client renders statuses but never enforces.

/** Generations allowed per user per rolling hour. */
export const AI_GEN_RATE_LIMIT_PER_HOUR = 20;
/** Max prompt chars accepted by POST /v1/generate. */
export const AI_PROMPT_MAX_CHARS = 2000;
/** Max generated HTML bytes stored/served. */
export const AI_SPEC_MAX_BYTES = 200_000;
/** Generation wall clock before the request aborts. */
export const AI_GEN_TIMEOUT_MS = 120_000;

export const GenerateRequest = z
  .object({
    /** Fresh generation prompt. Optional for edit-prompt requests (the
     * instruction carries intent; baseHtml carries the element's context). */
    prompt: z.string().max(AI_PROMPT_MAX_CHARS).optional(),
    /** Edit-prompt: regenerate from an existing element with an instruction. */
    baseHtml: z.string().max(AI_SPEC_MAX_BYTES).optional(),
    instruction: z.string().max(AI_PROMPT_MAX_CHARS).optional(),
  })
  .refine((r) => (r.baseHtml ? r.instruction?.trim() : r.prompt?.trim()), {
    message: "prompt required, or instruction with baseHtml",
  });
export type GenerateRequest = z.infer<typeof GenerateRequest>;

export const GenerateResult = z.object({
  title: z.string(),
  description: z.string(),
  html: z.string(),
});
export type GenerateResult = z.infer<typeof GenerateResult>;

export const GenerateErrorCode = z.enum([
  "FORBIDDEN",
  "RATE_LIMITED",
  "GENERATION_FAILED",
  "INVALID_REQUEST",
  "UNAUTHORIZED",
]);
export type GenerateErrorCode = z.infer<typeof GenerateErrorCode>;

export const GenerateError = z.object({
  error: GenerateErrorCode,
  message: z.string(),
  retryAfter: z.number().optional(),
});
export type GenerateError = z.infer<typeof GenerateError>;

export const AiAllowlistEntry = z.object({
  id: z.string(),
  email: z.string(),
  createdAt: z.string(),
});
export type AiAllowlistEntry = z.infer<typeof AiAllowlistEntry>;

export const LibraryEntry = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  description: z.string(),
  html: z.string(),
  specVersion: z.number(),
  createdAt: z.string(),
});
export type LibraryEntry = z.infer<typeof LibraryEntry>;
