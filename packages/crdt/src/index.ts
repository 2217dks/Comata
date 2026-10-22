import * as Y from "yjs";
import {
  BoardElementSchema,
  createRectElement,
  createStickyElement,
  uid,
  type BoardElement,
} from "@comata/elements";

// Yjs doc shape:
//   elements: Y.Map<elementId, Y.Map<field, value>>  — the element graph (R1)
//   meta:     Y.Map<key, value>                      — doc-level counters etc.
// The Liveblocks room carries this doc; SQL only ever snapshots it as a blob.

const ELEMENTS = "elements";
const META = "meta";

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

export function addRect(ydoc: Y.Doc, x: number, y: number): BoardElement {
  const el = createRectElement(uid(), x, y, nextZ(ydoc));
  insert(ydoc, el);
  return el;
}

export function addSticky(ydoc: Y.Doc, x: number, y: number): BoardElement {
  const el = createStickyElement(uid(), x, y, nextZ(ydoc));
  insert(ydoc, el);
  return el;
}

export function moveElement(ydoc: Y.Doc, id: string, x: number, y: number): void {
  const yel = getElements(ydoc).get(id);
  if (!yel) return;
  yel.set("x", x);
  yel.set("y", y);
}

export function bringToFront(ydoc: Y.Doc, id: string): void {
  const yel = getElements(ydoc).get(id);
  if (!yel) return;
  yel.set("z", nextZ(ydoc));
}

export function deleteElement(ydoc: Y.Doc, id: string): void {
  getElements(ydoc).delete(id);
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
