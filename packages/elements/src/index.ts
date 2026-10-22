import { z } from "zod";

// ── Element shell + payloads ─────────────────────────────────────────────────
// Uniform geometry shell (id/kind/x/y/w/h/rotation/z/fill) with per-kind
// payload fields (docs: element model invariant, RFC-001 spirit).
// Slice 1 set: rect, sticky. Slices 3+ extend the union — never reshape it.

export const ELEMENT_KINDS = ["rect", "sticky"] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];

const ElementBase = z.object({
  id: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  rotation: z.number().default(0),
  z: z.number().default(0),
  fill: z.string().default("#6c8cff"),
});

export const RectElement = ElementBase.extend({
  kind: z.literal("rect"),
});

export const StickyElement = ElementBase.extend({
  kind: z.literal("sticky"),
  text: z.string().default("New note"),
});

export const BoardElementSchema = z.discriminatedUnion("kind", [RectElement, StickyElement]);
export type BoardElement = z.infer<typeof BoardElementSchema>;
export type RectShape = z.infer<typeof RectElement>;
export type StickyShape = z.infer<typeof StickyElement>;

// ── Identity helpers ─────────────────────────────────────────────────────────

export const CURSOR_COLORS = ["#6c8cff", "#3ecf8e", "#f5b83d", "#ff6b6b", "#9a6cff", "#26c6da"] as const;

export function uid(): string {
  return "el-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function pickCursorColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return CURSOR_COLORS[hash % CURSOR_COLORS.length] as string;
}

// ── Element factories (defaults applied via Zod parse) ──────────────────────

export function createRectElement(id: string, x: number, y: number, z: number): RectShape {
  return RectElement.parse({ id, kind: "rect", x, y, w: 160, h: 100, z });
}

export function createStickyElement(id: string, x: number, y: number, z: number): StickyShape {
  return StickyElement.parse({
    id,
    kind: "sticky",
    x,
    y,
    w: 190,
    h: 170,
    z,
    fill: "#f5d76e",
    text: "New note",
  });
}
