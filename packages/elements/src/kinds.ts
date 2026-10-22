import { z } from "zod";

// ── Element shell + payloads ─────────────────────────────────────────────────
// Uniform geometry shell (id/kind/x/y/w/h/rotation/z) with per-kind payload
// fields (docs: element model invariant, RFC-001 spirit). Never reshape the
// shell — new kinds only extend the discriminated union.

export const ELEMENT_KINDS = [
  "rect",
  "ellipse",
  "line",
  "arrow",
  "sticky",
  "ink",
  "text",
  "frame",
  "custom",
] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];

const ElementBase = z.object({
  id: z.string(),
  x: z.number(),
  y: z.number(),
  /** w/h are the bounding box; for line/arrow they are the (dx, dy) endpoint offset. */
  w: z.number(),
  h: z.number(),
  rotation: z.number().default(0),
  z: z.number().default(0),
  fill: z.string().default("#6c8cff"),
  stroke: z.string().default("#e7eaf0"),
  strokeWidth: z.number().default(2),
  opacity: z.number().default(1),
});

/** Border placement relative to the shape edge (Figma's stroke align).
 * The hitbox always stays the ORIGINAL rectangle edge regardless of alignment. */
export const StrokeAlign = z.enum(["outer", "middle", "inner"]).default("middle");
export type StrokeAlignKind = z.infer<typeof StrokeAlign>;

export const RectElement = ElementBase.extend({
  kind: z.literal("rect"),
  strokeAlign: StrokeAlign,
});

export const EllipseElement = ElementBase.extend({
  kind: z.literal("ellipse"),
  strokeAlign: StrokeAlign,
});

export const LineElement = ElementBase.extend({
  kind: z.literal("line"),
});

export const ArrowElement = ElementBase.extend({
  kind: z.literal("arrow"),
});

export const StickyElement = ElementBase.extend({
  kind: z.literal("sticky"),
  text: z.string().default("New note"),
});

export const InkElement = ElementBase.extend({
  kind: z.literal("ink"),
  /** Flat [dx, dy, …] polyline relative to (x, y). */
  points: z.array(z.number()),
  mode: z.enum(["pen", "highlighter"]).default("pen"),
});

export const TextElement = ElementBase.extend({
  kind: z.literal("text"),
  text: z.string().default("Text"),
  fontSize: z.number().default(20),
  bold: z.boolean().default(false),
  italic: z.boolean().default(false),
  /** Horizontal alignment inside the text box. */
  align: z.enum(["left", "center", "right"]).default("left"),
  /** Vertical alignment inside the text box. */
  valign: z.enum(["top", "middle", "bottom"]).default("top"),
});

export const FrameElement = ElementBase.extend({
  kind: z.literal("frame"),
  name: z.string().default("Frame"),
});

/**
 * Custom element (Slice 5b): an AI-generated micro-simulation described in
 * natural language. `prompt` is the user's NL description; `spec` carries the
 * versioned generated payload (JSON spec or sandboxed HTML/JS) that renders
 * the interactive visualization. Shared via the Yjs doc like any element, so
 * snapshots and `.comata` export/import carry it for free.
 */
export const CustomElement = ElementBase.extend({
  kind: z.literal("custom"),
  title: z.string().default("Custom element"),
  prompt: z.string().default(""),
  spec: z.string().default(""),
  specVersion: z.number().default(0),
});

export const BoardElementSchema = z.discriminatedUnion("kind", [
  RectElement,
  EllipseElement,
  LineElement,
  ArrowElement,
  StickyElement,
  InkElement,
  TextElement,
  FrameElement,
  CustomElement,
]);
export type BoardElement = z.infer<typeof BoardElementSchema>;
export type RectShape = z.infer<typeof RectElement>;
export type EllipseShape = z.infer<typeof EllipseElement>;
export type LineShape = z.infer<typeof LineElement>;
export type ArrowShape = z.infer<typeof ArrowElement>;
export type StickyShape = z.infer<typeof StickyElement>;
export type InkShape = z.infer<typeof InkElement>;
export type TextShape = z.infer<typeof TextElement>;
export type FrameShape = z.infer<typeof FrameElement>;
export type CustomShape = z.infer<typeof CustomElement>;

/** Patch shape for element updates (id/kind immutable). Distributed over the
 * union so per-kind payload fields (text, fontSize, points, …) are patchable. */
type ElementPatchPart<T> = T extends BoardElement ? Partial<Omit<T, "id" | "kind">> : never;
export type ElementPatch = ElementPatchPart<BoardElement>;

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
  return RectElement.parse({ id, kind: "rect", x, y, w: 160, h: 100, z, strokeAlign: "middle" });
}

export function createEllipseElement(id: string, x: number, y: number, z: number): EllipseShape {
  return EllipseElement.parse({ id, kind: "ellipse", x, y, w: 140, h: 140, z, strokeAlign: "middle" });
}

export function createLineElement(
  kind: "line" | "arrow",
  id: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  z: number,
): LineShape | ArrowShape {
  return (kind === "line" ? LineElement : ArrowElement).parse({
    id,
    kind,
    x: x1,
    y: y1,
    w: x2 - x1,
    h: y2 - y1,
    z,
  });
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
    text: "",
  });
}

/** Build an ink element from flat world-space points; origin moves to the bbox corner. */
export function createInkElement(
  id: string,
  mode: "pen" | "highlighter",
  worldPoints: number[],
  z: number,
): InkShape {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < worldPoints.length; i += 2) {
    minX = Math.min(minX, worldPoints[i] as number);
    maxX = Math.max(maxX, worldPoints[i] as number);
    minY = Math.min(minY, worldPoints[i + 1] as number);
    maxY = Math.max(maxY, worldPoints[i + 1] as number);
  }
  if (!Number.isFinite(minX)) {
    minX = minY = maxX = maxY = 0;
  }
  const rel: number[] = [];
  for (let i = 0; i < worldPoints.length; i += 2) {
    rel.push((worldPoints[i] as number) - minX, (worldPoints[i + 1] as number) - minY);
  }
  const isHighlighter = mode === "highlighter";
  return InkElement.parse({
    id,
    kind: "ink",
    x: minX,
    y: minY,
    w: Math.max(1, maxX - minX),
    h: Math.max(1, maxY - minY),
    z,
    points: rel,
    mode,
    stroke: isHighlighter ? "#f5b83d" : "#e7eaf0",
    strokeWidth: isHighlighter ? 14 : 2.5,
    opacity: isHighlighter ? 0.35 : 1,
  });
}

export function createTextElement(id: string, x: number, y: number, z: number): TextShape {
  return TextElement.parse({
    id,
    kind: "text",
    x,
    y,
    w: 260,
    h: 60,
    z,
    fill: "#e7eaf0",
    text: "",
    fontSize: 20,
    align: "left",
    valign: "top",
  });
}

export function createFrameElement(
  id: string,
  x: number,
  y: number,
  z: number,
  name?: string,
): FrameShape {
  return FrameElement.parse({
    id,
    kind: "frame",
    x,
    y,
    w: 400,
    h: 300,
    z,
    fill: "#171b24",
    name: name ?? "Frame",
  });
}

export function createCustomElement(
  id: string,
  x: number,
  y: number,
  z: number,
  init?: { title?: string; prompt?: string; spec?: string },
): CustomShape {
  return CustomElement.parse({
    id,
    kind: "custom",
    x,
    y,
    w: 260,
    h: 180,
    z,
    fill: "#1a1626",
    stroke: "#9a6cff",
    title: init?.title ?? "Custom element",
    prompt: init?.prompt ?? "",
    spec: init?.spec ?? "",
  });
}

/** Clone with a new id, top z, and a small offset (duplicate interaction). */
export function cloneElement<T extends BoardElement>(el: T, id: string, z: number): T {
  return { ...el, id, z, x: el.x + 16, y: el.y + 16 };
}
