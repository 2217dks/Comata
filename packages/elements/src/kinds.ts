import { z } from "zod";

// ── Element shell + payloads ─────────────────────────────────────────────────
// Uniform geometry shell (id/kind/x/y/w/h/rotation/z/pageId) with per-kind
// payload fields (docs: element model invariant, RFC-001 spirit; ADR-0005 for
// the pageId reshape). New kinds only extend the discriminated union.

export const ELEMENT_KINDS = [
  "rect",
  "ellipse",
  "line",
  "arrow",
  "sticky",
  "ink",
  "text",
  "custom",
  "code",
  "math",
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
  /** Owning page in presentation notebooks (ADR-0005). Canvas-notebook
   * elements leave it "" — the canvas has no pages. */
  pageId: z.string().default(""),
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

/**
 * Custom element (Slice 5b): an AI-generated micro-simulation described in
 * natural language. `prompt` is the user's NL description; `spec` carries the
 * versioned generated payload — a single self-contained HTML file rendered
 * sandboxed via iframe srcdoc. Shared via the Yjs doc like any element, so
 * snapshots and `.comata` export/import carry it for free. `status` rides the
 * doc too: the wavy generating box is visible to every viewer; spec/HTML and
 * error text are plain shared fields (per docs/custom-elements.md §4).
 */
export const CustomElement = ElementBase.extend({
  kind: z.literal("custom"),
  title: z.string().default("Custom element"),
  prompt: z.string().default(""),
  spec: z.string().default(""),
  specVersion: z.number().default(0),
  status: z.enum(["generating", "ready", "error"]).default("ready"),
  errorMessage: z.string().default(""),
  description: z.string().default(""),
  /** Row id in the generator's account library (GeneratedElement), when the
   * element was spawned from a generation this user performed. */
  libraryId: z.string().default(""),
});

/**
 * Code element (Slice 4): one named single-file program. Source, filename and
 * language are shared via the doc and collaboratively editable; stdin and run
 * results are per-user, local-only and never enter the doc (ADR-0003).
 * `scale` is the element-wide text zoom stepped by the [- +] control.
 */
export const CodeElement = ElementBase.extend({
  kind: z.literal("code"),
  filename: z.string().default(""),
  language: z.string().default("python"),
  source: z.string().default(""),
  scale: z.number().default(1),
});

/** One row of the math element's Desmos-lite expression sidebar. Shared via
 * the doc; `color` is a fixed palette index chosen at row creation. */
export const MathExpression = z.object({
  id: z.string(),
  text: z.string().default(""),
  color: z.string().default("#6c8cff"),
  visible: z.boolean().default(true),
});

/** Slider definition for a free variable discovered in an expression. Defaults
 * are shared via the doc; the live slider value is per-user local (ADR-0003
 * pattern — same split as stdin). */
export const MathParam = z.object({
  name: z.string(),
  min: z.number().default(-10),
  max: z.number().default(10),
  step: z.number().default(0.1),
  defaultValue: z.number().default(1),
});

/**
 * Math element ("mathblock", Slice 5): a Desmos-lite block — expression
 * sidebar + plot. `mode` is mutable (2D↔3D toggle in the element chrome);
 * one-variable expressions plot as a curve-on-plane in 3D, two-variable
 * `z=f(x,y)` as a shaded surface. View state (pan/zoom/rotate) is per-user
 * local and never enters the doc.
 */
export const MathElement = ElementBase.extend({
  kind: z.literal("math"),
  mode: z.enum(["2d", "3d"]).default("2d"),
  expressions: z.array(MathExpression).default([]),
  params: z.array(MathParam).default([]),
});

export const BoardElementSchema = z.discriminatedUnion("kind", [
  RectElement,
  EllipseElement,
  LineElement,
  ArrowElement,
  StickyElement,
  InkElement,
  TextElement,
  CustomElement,
  CodeElement,
  MathElement,
]);
export type BoardElement = z.infer<typeof BoardElementSchema>;
export type RectShape = z.infer<typeof RectElement>;
export type EllipseShape = z.infer<typeof EllipseElement>;
export type LineShape = z.infer<typeof LineElement>;
export type ArrowShape = z.infer<typeof ArrowElement>;
export type StickyShape = z.infer<typeof StickyElement>;
export type InkShape = z.infer<typeof InkElement>;
export type TextShape = z.infer<typeof TextElement>;
export type CustomShape = z.infer<typeof CustomElement>;
export type CodeShape = z.infer<typeof CodeElement>;
export type MathShape = z.infer<typeof MathElement>;
export type MathExpressionRow = z.infer<typeof MathExpression>;
export type MathParamDef = z.infer<typeof MathParam>;

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

// ── Background-aware defaults (ADR-0006 companion) ──────────────────────────
// Element default colors derive from the surface's background luminance:
// light background → dark ink/text, dark background → light. The surface is
// a page (presentation notebooks) or the notebook background (canvas).

/** Relative luminance (0 dark … 1 light) of a #rrggbb color. */
export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m || !m[1]) return 0; // unparsable → treat as dark
  const n = parseInt(m[1], 16);
  // Rec. 709 coefficients on the sRGB channels.
  return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 0xff) + 0.0722 * (n & 0xff)) / 255;
}

export function isLightBackground(bg: string): boolean {
  return luminance(bg) >= 0.5;
}

/** Ink/text stroke + fill defaults for a background. */
export function elementDefaultsFor(bg: string): { ink: string; text: string; shapeStroke: string } {
  return isLightBackground(bg)
    ? { ink: "#1a1d24", text: "#1a1d24", shapeStroke: "#2a2e38" }
    : { ink: "#e7eaf0", text: "#e7eaf0", shapeStroke: "#e7eaf0" };
}

export function createCustomElement(
  id: string,
  x: number,
  y: number,
  z: number,
  init?: {
    title?: string;
    prompt?: string;
    spec?: string;
    status?: "generating" | "ready" | "error";
    libraryId?: string;
    description?: string;
  },
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
    status: init?.status ?? "ready",
    libraryId: init?.libraryId ?? "",
    description: init?.description ?? "",
  });
}

/** Clone with a new id, top z, and a small offset (duplicate interaction). */
export function cloneElement<T extends BoardElement>(el: T, id: string, z: number): T {
  return { ...el, id, z, x: el.x + 16, y: el.y + 16 };
}

// ── Code element naming (VS Code "Untitled-N" pattern) ──────────────────────

export const CODE_LANGUAGE_EXTENSIONS: Record<string, string> = {
  python: "py",
  javascript: "js",
  typescript: "ts",
  c: "c",
  cpp: "cpp",
  java: "java",
  rust: "rs",
  go: "go",
};

export function codeExtensionFor(language: string): string {
  return CODE_LANGUAGE_EXTENSIONS[language] ?? "txt";
}

/** Display name for a code element: the stored filename, or the canonical
 * `Untitled-N.ext` derived from the language when unset. */
export function codeDisplayName(el: { filename: string; language: string; id?: string }): string {
  if (el.filename) return el.filename;
  const n = el.id ? Number.parseInt(el.id.slice(-6), 36) : NaN;
  const seq = Number.isFinite(n) ? Math.abs(n) % 1000 : 0;
  return `Untitled-${seq}.${codeExtensionFor(el.language)}`;
}

/** ElementPatch-friendly rename: keeps the bare name, swaps the extension to
 * match the language. "init" + cpp → "init.cpp". */
export function codeFileNameFor(name: string, language: string): string {
  const bare = name.replace(/\.[^.]+$/, "").trim() || "Untitled";
  return `${bare}.${codeExtensionFor(language)}`;
}

export function createCodeElement(
  id: string,
  x: number,
  y: number,
  z: number,
  init?: { language?: string; filename?: string; source?: string },
): CodeShape {
  return CodeElement.parse({
    id,
    kind: "code",
    x,
    y,
    w: 460,
    h: 420,
    z,
    fill: "#161a23",
    stroke: "#3a4256",
    language: init?.language ?? "python",
    filename: init?.filename ?? "",
    source: init?.source ?? "",
  });
}

/** Curve palette cycled per expression row, Desmos-style. */
export const MATH_CURVE_COLORS = [
  "#6c8cff",
  "#e879a9",
  "#38bdf8",
  "#f59e0b",
  "#34d399",
  "#a78bfa",
] as const;

export function createMathElement(
  id: string,
  x: number,
  y: number,
  z: number,
  init?: { mode?: "2d" | "3d" },
): MathShape {
  return MathElement.parse({
    id,
    kind: "math",
    x,
    y,
    w: 520,
    h: 440,
    z,
    fill: "#ffffff",
    stroke: "#e7eaf0",
    mode: init?.mode ?? "2d",
    expressions: [
      { id: `${id}-e1`, text: "sin(x)", color: MATH_CURVE_COLORS[0], visible: true },
    ],
    params: [],
  });
}
