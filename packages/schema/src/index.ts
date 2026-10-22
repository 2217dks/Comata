import { z } from "zod";

// ── App constants ────────────────────────────────────────────────────────────

export const APP_NAME = "Comata";

/** Element kinds — the RFC-001-style uniform element system (Slice 1+). */
export const ELEMENT_KINDS = ["ink", "shape", "text", "code", "math", "frame", "image"] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];

// ── Notebook domain (Slice 2 — models per docs/data-model.md) ───────────────

export const NotebookKind = z.enum(["canvas", "presentation"]);
export type NotebookKind = z.infer<typeof NotebookKind>;

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
  role: MemberRole,
  updatedAt: z.string(),
});
export type NotebookSummary = z.infer<typeof NotebookSummary>;

export const NotebookListResponse = z.object({
  notebooks: z.array(NotebookSummary),
});
export type NotebookListResponse = z.infer<typeof NotebookListResponse>;
