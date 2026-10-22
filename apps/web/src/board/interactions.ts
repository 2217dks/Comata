import type { BoardElement } from "@comata/elements";

// ── Interaction core (tldraw/Excalidraw model) ───────────────────────────────
// Pure, render-agnostic helpers + the pointer state machine type. One
// interaction owns the pointer at a time; the Board translates DOM events into
// transitions on this machine.

export type Vec = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

/** Screen-space pointer travel that separates a click from a drag.
 * tldraw and Excalidraw both use ~4-5px. */
export const DRAG_THRESHOLD = 5;

/** Where a pointerdown on an element (or inside the selection's bounding box)
 * started from, for group moves. `id === null` = pressed the selection-box
 * background, not a specific element. */
export type ShapeOrigin = { id: string; x: number; y: number };

/** The pointer state machine (mirrors tldraw's interaction states).
 *
 * Select tool on an element has the full 3-state model:
 * hover (no click) → press + move = drag the whole selection →
 * press + release without move = click-select (collapses a multi-selection). */
export type Interaction =
  | { kind: "idle" }
  | { kind: "pan"; lastScreen: Vec }
  | { kind: "marquee"; startWorld: Vec }
  | { kind: "lasso"; points: Vec[] }
  | { kind: "ink"; mode: "pen" | "highlighter" }
  | {
      kind: "pointShape";
      id: string | null;
      wasInSelection: boolean;
      startWorld: Vec;
      orig: ShapeOrigin[];
    }
  | {
      kind: "create";
      tool: "line" | "arrow" | "shape" | "sticky" | "text";
      startWorld: Vec;
    };

export const IDLE: Interaction = { kind: "idle" };

export function normRect(a: Vec, b: Vec): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

/** Shape-aware hit test (Canva-like): line/arrow answer to their **stroke**
 * (segment distance + tolerance), everything else to its bounding box.
 * `tol` is extra slack in world units (callers pass screen-px / scale). */
export function hitTestElement(el: BoardElement, p: Vec, tol: number): boolean {
  if (el.kind === "line" || el.kind === "arrow") {
    return (
      distToSegment(p, { x: el.x, y: el.y }, { x: el.x + el.w, y: el.y + el.h }) <=
      el.strokeWidth / 2 + tol
    );
  }
  return p.x >= el.x && p.x <= el.x + el.w && p.y >= el.y && p.y <= el.y + el.h;
}

function distToSegment(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Topmost clickable element under a world point (ink is click-immune —
 * strokes are only selectable via marquee/lasso). */
export function elementAtPoint(elements: BoardElement[], p: Vec, tol: number): BoardElement | null {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i] as BoardElement;
    if (el.kind === "ink") continue;
    if (hitTestElement(el, p, tol)) return el;
  }
  return null;
}

/** All elements intersecting a world rect — including ink (marquee selects strokes).
 * Edges are inclusive: a marquee that merely **touches** an element selects it. */
export function elementsInRect(elements: BoardElement[], r: Rect): BoardElement[] {
  return elements.filter(
    (el) => el.x <= r.x + r.w && el.x + el.w >= r.x && el.y <= r.y + r.h && el.y + el.h >= r.y,
  );
}

/** Ray-casting point-in-polygon for the lasso. */
export function pointInPolygon(p: Vec, poly: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = (poly[i] as Vec).x;
    const yi = (poly[i] as Vec).y;
    const xj = (poly[j] as Vec).x;
    const yj = (poly[j] as Vec).y;
    const intersects = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Lasso selects an element when any bbox corner or its center is inside the
 * freehand polygon (ink included — lasso is a stroke-selection path too). */
export function elementsInLasso(elements: BoardElement[], poly: Vec[]): BoardElement[] {
  if (poly.length < 3) return [];
  return elements.filter((el) => {
    const x2 = el.x + el.w;
    const y2 = el.y + el.h;
    const corners: Vec[] = [
      { x: el.x, y: el.y },
      { x: x2, y: el.y },
      { x: el.x, y: y2 },
      { x: x2, y: y2 },
      { x: el.x + el.w / 2, y: el.y + el.h / 2 },
    ];
    return corners.some((c) => pointInPolygon(c, poly));
  });
}

/** Flat [x0,y0,x1,y1,…] → smooth quadratic path (midpoint technique). */
const r2 = (v: number) => Math.round(v * 100) / 100;
