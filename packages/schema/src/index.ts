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
