import * as Y from "yjs";
import {
  BoardElementSchema,
  cloneElement,
  createCustomElement,
  createEllipseElement,
  createFrameElement,
  createInkElement,
  createLineElement,
  createRectElement,
  createStickyElement,
  createTextElement,
  uid,
  type BoardElement,
  type ElementPatch,
} from "@comata/elements";

// Yjs doc shape:
//   elements: Y.Map<elementId, Y.Map<field, value>>  — the element graph (R1)
//   meta:     Y.Map<key, value>                      — doc-level counters etc.
// The Liveblocks room carries this doc; SQL only ever snapshots it as a blob.

const ELEMENTS = "elements";
const META = "meta";

/** Transaction origin for every locally-initiated change. The per-user
 * UndoManager tracks ONLY this origin (Canva behavior: your undo never
 * reverts other people's edits), so remote-applied updates — whose origin is
 * the provider or anything else — stay out of your undo stack. */
export const LOCAL_ORIGIN = "comata-local";

/** Origin for bulk restores (snapshot load/merge) — never undo-tracked. */
export const RESTORE_ORIGIN = "comata-restore";

function localTx(ydoc: Y.Doc, fn: () => void): void {
  ydoc.transact(fn, LOCAL_ORIGIN);
}

/** A per-user undo/redo manager scoped to the elements graph. Transactions
 * from the same local session merge while within `captureTimeout` of each
 * other (so a throttled drag = ONE undo step, a typing burst = one step);
 * call `stopCapturing()` at gesture boundaries to force a split. */
export function createUndoManager(ydoc: Y.Doc): Y.UndoManager {
  return new Y.UndoManager(getElements(ydoc), {
    trackedOrigins: new Set([LOCAL_ORIGIN]),
    captureTimeout: 500,
  });
}

export function getElements(ydoc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return ydoc.getMap<Y.Map<unknown>>(ELEMENTS);
}

function nextZ(ydoc: Y.Doc): number {
  const meta = ydoc.getMap<number>(META);
  const z = (meta.get("zCounter") ?? 0) + 1;
  meta.set("zCounter", z);
  return z;
}

function insert(ydoc: Y.Doc, el: BoardElement): void {
  getElements(ydoc).set(el.id, new Y.Map(Object.entries(el)));
}

/** Create any placement-kind element at a point (click-to-place tools). */
export function addElement(
  ydoc: Y.Doc,
  kind: "rect" | "ellipse" | "sticky" | "text" | "frame",
  x: number,
  y: number,
  opts?: { frameName?: string; w?: number; h?: number },
): BoardElement {
  const z = nextZ(ydoc);
  const id = uid();
  let el: BoardElement;
  switch (kind) {
    case "rect":
      el = createRectElement(id, x, y, z);
      break;
    case "ellipse":
      el = createEllipseElement(id, x, y, z);
      break;
    case "sticky":
      el = createStickyElement(id, x, y, z);
      break;
    case "text":
      el = createTextElement(id, x, y, z);
      break;
    case "frame": {
      const count = countKind(ydoc, "frame");
      el = createFrameElement(id, x, y, z, opts?.frameName ?? `Frame ${count + 1}`);
      break;
    }
  }
  if (opts?.w !== undefined || opts?.h !== undefined) {
    el = { ...el, w: opts.w ?? el.w, h: opts.h ?? el.h };
  }
  localTx(ydoc, () => insert(ydoc, el));
  return el;
}

/** Commit a dragged line/arrow (x1,y1 → x2,y2). */
export function addLineElement(
  ydoc: Y.Doc,
  kind: "line" | "arrow",
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): BoardElement {
  const el = createLineElement(kind, uid(), x1, y1, x2, y2, nextZ(ydoc));
  localTx(ydoc, () => insert(ydoc, el));
  return el;
}

/** Commit an ink stroke from flat world-space points. */
export function addInkElement(
  ydoc: Y.Doc,
  mode: "pen" | "highlighter",
  worldPoints: number[],
): BoardElement {
  const el = createInkElement(uid(), mode, worldPoints, nextZ(ydoc));
  localTx(ydoc, () => insert(ydoc, el));
  return el;
}

/** Insert an AI-generated custom element (Slice 5b generation flow). */
export function addCustomElement(
  ydoc: Y.Doc,
  x: number,
  y: number,
  init?: { title?: string; prompt?: string; spec?: string },
): BoardElement {
  const el = createCustomElement(uid(), x, y, nextZ(ydoc), init);
  localTx(ydoc, () => insert(ydoc, el));
  return el;
}

function countKind(ydoc: Y.Doc, kind: BoardElement["kind"]): number {
  let n = 0;
  getElements(ydoc).forEach((raw) => {
    if (raw.get("kind") === kind) n++;
  });
  return n;
}

/** Patch any mutable fields on an element (move/resize/rotate/restyle/text). */
export function updateElement(ydoc: Y.Doc, id: string, patch: ElementPatch): void {
  const yel = getElements(ydoc).get(id);
  if (!yel) return;
  localTx(ydoc, () => {
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) yel.set(key, value);
    }
  });
}

export function duplicateElement(ydoc: Y.Doc, id: string): BoardElement | null {
  const raw = getElements(ydoc).get(id);
  if (!raw) return null;
  const parsed = BoardElementSchema.safeParse(Object.fromEntries(raw.entries()));
  if (!parsed.success) return null;
  const copy = cloneElement(parsed.data, uid(), nextZ(ydoc));
  localTx(ydoc, () => insert(ydoc, copy));
  return copy;
}

/** Paste (or duplicate) a batch of elements with fresh ids and an offset —
 * one transaction, so the whole paste is a single undo step. */
export function pasteElements(
  ydoc: Y.Doc,
  els: BoardElement[],
  offset: { x: number; y: number },
): BoardElement[] {
  const out: BoardElement[] = [];
  localTx(ydoc, () => {
    for (const el of els) {
      const copy = { ...el, id: uid(), z: nextZ(ydoc), x: el.x + offset.x, y: el.y + offset.y };
      insert(ydoc, copy);
      out.push(copy);
    }
  });
  return out;
}

export function bringToFront(ydoc: Y.Doc, id: string): void {
  localTx(ydoc, () => {
    const yel = getElements(ydoc).get(id);
    if (yel) yel.set("z", nextZ(ydoc));
  });
}

export function sendToBack(ydoc: Y.Doc, id: string): void {
  localTx(ydoc, () => {
    let min = Infinity;
    getElements(ydoc).forEach((other) => {
      if (other.get("id") !== id) min = Math.min(min, (other.get("z") as number) ?? 0);
    });
    const yel = getElements(ydoc).get(id);
    if (yel) yel.set("z", Number.isFinite(min) ? min - 1 : 0);
  });
}

/** Move exactly one slot up/down the z stack (Figma's ] / [ behaviour). */
export function moveZForward(ydoc: Y.Doc, id: string): void {
  shiftZ(ydoc, id, +1);
}

export function moveZBackward(ydoc: Y.Doc, id: string): void {
  shiftZ(ydoc, id, -1);
}

function shiftZ(ydoc: Y.Doc, id: string, delta: number): void {
  const sorted = projectBoard(ydoc); // z ascending
  const idx = sorted.findIndex((e) => e.id === id);
  if (idx < 0) return;
  const target = sorted[idx + delta];
  if (!target) return;
  localTx(ydoc, () => {
    const ymap = getElements(ydoc);
    const a = ymap.get(id);
    const b = ymap.get(target.id);
    if (!a || !b) return;
    const za = a.get("z") as number;
    a.set("z", b.get("z") as number);
    b.set("z", za);
  });
}

export function deleteElement(ydoc: Y.Doc, id: string): void {
  localTx(ydoc, () => getElements(ydoc).delete(id));
}

/** Project the Yjs doc into the plain, sorted element list the renderer consumes. */
export function projectBoard(ydoc: Y.Doc): BoardElement[] {
  const out: BoardElement[] = [];
  getElements(ydoc).forEach((raw) => {
    const parsed = BoardElementSchema.safeParse(Object.fromEntries(raw.entries()));
    if (parsed.success) out.push(parsed.data);
  });
  return out.sort((a, b) => a.z - b.z || a.id.localeCompare(b.id));
}
