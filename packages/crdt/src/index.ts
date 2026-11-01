import * as Y from "yjs";
import {
  BoardElementSchema,
  cloneElement,
  codeDisplayName,
  CODE_LANGUAGE_EXTENSIONS,
  createCodeElement,
  createCustomElement,
  createEllipseElement,
  createInkElement,
  createMathElement,
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
//   pages:    Y.Array<Y.Map>                         — ordered page records
//             (presentation notebooks; each: id, background)
//   meta:     Y.Map<key, value>                      — doc-level counters etc.
// The Liveblocks room carries this doc; SQL only ever snapshots it as a blob.
// ADR-0005: elements carry `pageId` — one map, identity-preserving page moves.

const ELEMENTS = "elements";
const PAGES = "pages";
const META = "meta";

/** Page size in world units — 16:9 (ADR-0005). Element coordinates are
 * page-local; every page shares this same space. */
export const PAGE_W = 1920;
export const PAGE_H = 1080;

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

/** A per-user undo/redo manager scoped to the elements graph AND the page
 * list — deleting/restoring a page and its elements is one undo step. */
export function createUndoManager(ydoc: Y.Doc): Y.UndoManager {
  return new Y.UndoManager([getElements(ydoc), getPages(ydoc)], {
    trackedOrigins: new Set([LOCAL_ORIGIN]),
    captureTimeout: 500,
  });
}

export function getElements(ydoc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return ydoc.getMap<Y.Map<unknown>>(ELEMENTS);
}

export function getPages(ydoc: Y.Doc): Y.Array<Y.Map<unknown>> {
  return ydoc.getArray<Y.Map<unknown>>(PAGES);
}

export type PageRecord = {
  id: string;
  /** Page background color (presentation notebooks; per-page choice). */
  background: string;
};

/** Ordered page list, projected. Presentation notebooks always have ≥1 page
 * (creation seeds page 1); an empty array means a canvas notebook or a
 * pre-Slice-7 doc. */
export function projectPages(ydoc: Y.Doc): PageRecord[] {
  const out: PageRecord[] = [];
  getPages(ydoc).forEach((raw) => {
    const id = raw.get("id");
    if (typeof id !== "string") return;
    out.push({ id, background: typeof raw.get("background") === "string" ? (raw.get("background") as string) : "#ffffff" });
  });
  return out;
}

/** Default background for the first page — matches the app's dark canvas. */
export const DEFAULT_PAGE_BACKGROUND = "#171b24";

/** Ensure a presentation doc has its page 1 (idempotent; runs on open). */
export function ensurePages(ydoc: Y.Doc): void {
  if (getPages(ydoc).length === 0) {
    localTx(ydoc, () => {
      getPages(ydoc).insert(0, [new Y.Map(Object.entries({
        id: uid(),
        background: DEFAULT_PAGE_BACKGROUND,
      }))]);
    });
  }
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

/** Create any placement-kind element at a point (click-to-place tools).
 * Presentation notebooks pass the owning page id — every element needs one
 * there (ADR-0005); canvas notebooks pass "" (the default). */
export function addElement(
  ydoc: Y.Doc,
  kind: "rect" | "ellipse" | "sticky" | "text" | "code" | "math" | "custom",
  x: number,
  y: number,
  opts?: { pageId?: string; w?: number; h?: number },
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
    case "code": {
      el = createCodeElement(id, x, y, z, { filename: nextCodeFilename(ydoc, "python") });
      break;
    }
    case "math": {
      el = createMathElement(id, x, y, z);
      break;
    }
    case "custom": {
      el = createCustomElement(id, x, y, z, { title: "AI element", status: "generating" });
      break;
    }
  }
  if (opts?.pageId !== undefined || opts?.w !== undefined || opts?.h !== undefined) {
    el = { ...el, pageId: opts?.pageId ?? el.pageId, w: opts?.w ?? el.w, h: opts?.h ?? el.h };
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
  pageId?: string,
): BoardElement {
  const el = { ...createLineElement(kind, uid(), x1, y1, x2, y2, nextZ(ydoc)), pageId: pageId ?? "" };
  localTx(ydoc, () => insert(ydoc, el));
  return el;
}

/** Commit an ink stroke from flat world-space points. */
export function addInkElement(
  ydoc: Y.Doc,
  mode: "pen" | "highlighter",
  worldPoints: number[],
  pageId?: string,
): BoardElement {
  const el = { ...createInkElement(uid(), mode, worldPoints, nextZ(ydoc)), pageId: pageId ?? "" };
  localTx(ydoc, () => insert(ydoc, el));
  return el;
}

/** Insert an AI-generated custom element (Slice 5b generation flow). */
export function addCustomElement(
  ydoc: Y.Doc,
  x: number,
  y: number,
  init?: { title?: string; prompt?: string; spec?: string; pageId?: string },
): BoardElement {
  const base = createCustomElement(uid(), x, y, nextZ(ydoc), init);
  const el = init?.pageId ? { ...base, pageId: init.pageId } : base;
  localTx(ydoc, () => insert(ydoc, el));
  return el;
}

/** Next free code filename for a language: "Untitled.py", then
 * "Untitled-1.py", "Untitled-2.py", … (VS Code pattern, per-notebook unique). */
export function nextCodeFilename(ydoc: Y.Doc, language: string): string {
  const taken = new Set<string>();
  getElements(ydoc).forEach((raw) => {
    if (raw.get("kind") === "code") taken.add(String(raw.get("filename") ?? ""));
  });
  const ext = CODE_LANGUAGE_EXTENSIONS[language] ?? "txt";
  let name = `Untitled.${ext}`;
  for (let i = 0; taken.has(name); i++) {
    name = `Untitled-${i}.${ext}`;
  }
  return name;
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

/** Patch many elements in ONE transaction — a multi-selection drag issues a
 * single doc update (and a single undo entry) instead of one per element per
 * tick. Same semantics as N updateElement calls, batched. */
export function updateElements(ydoc: Y.Doc, patches: { id: string; patch: ElementPatch }[]): void {
  if (patches.length === 0) return;
  if (patches.length === 1) {
    const first = patches[0];
    if (first) updateElement(ydoc, first.id, first.patch);
    return;
  }
  localTx(ydoc, () => {
    for (const { id, patch } of patches) {
      const yel = getElements(ydoc).get(id);
      if (!yel) continue;
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) yel.set(key, value);
      }
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
 * one transaction, so the whole paste is a single undo step. Pasted elements
 * land on `pageId` (presentation notebooks pass the current page; default ""
 * keeps the source pageId for canvas docs). */
export function pasteElements(
  ydoc: Y.Doc,
  els: BoardElement[],
  offset: { x: number; y: number },
  pageId?: string,
): BoardElement[] {
  const out: BoardElement[] = [];
  localTx(ydoc, () => {
    for (const el of els) {
      const copy = {
        ...el,
        id: uid(),
        z: nextZ(ydoc),
        x: el.x + offset.x,
        y: el.y + offset.y,
        ...(pageId !== undefined ? { pageId } : {}),
      };
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

/** Move up/down the z stack — Canva semantics: "forward" skips past every
 * non-overlapping element and lands just above the highest element that
 * actually overlaps this one (an element visually never changes when it has
 * nothing above it to trade places with). Falls back to the immediate
 * neighbor when nothing overlaps. */
export function moveZForward(ydoc: Y.Doc, id: string): void {
  shiftZPastOverlaps(ydoc, id, +1);
}

export function moveZBackward(ydoc: Y.Doc, id: string): void {
  shiftZPastOverlaps(ydoc, id, -1);
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function shiftZPastOverlaps(ydoc: Y.Doc, id: string, delta: number): void {
  const sorted = projectBoard(ydoc); // z ascending
  const idx = sorted.findIndex((e) => e.id === id);
  if (idx < 0) return;
  const el = sorted[idx] as (typeof sorted)[number];
  // Candidates in the movement direction that actually overlap this element.
  const overlapping = sorted.filter((o, i) => {
    if (i === idx) return false;
    if (delta > 0 ? o.z <= el.z : o.z >= el.z) return false;
    return overlaps(el, o);
  });
  let target: (typeof sorted)[number] | undefined;
  if (overlapping.length > 0) {
    // Highest-z overlapping element in the direction of travel.
    target = delta > 0
      ? overlapping.reduce((m, o) => (o.z > m.z ? o : m), overlapping[0] as (typeof sorted)[number])
      : overlapping.reduce((m, o) => (o.z < m.z ? o : m), overlapping[0] as (typeof sorted)[number]);
  } else {
    target = sorted[idx + delta]; // nothing overlapping — plain neighbor swap
  }
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

// ── Page operations (Slice 7, ADR-0005) ─────────────────────────────────────
// All page list + element ownership changes run in ONE transaction so undo
// restores page + elements together, and every peer sees an atomic flip.

function newPageRecord(background = DEFAULT_PAGE_BACKGROUND): Y.Map<unknown> {
  return new Y.Map(Object.entries({ id: uid().replace("el-", "pg-"), background }));
}

/** Append a new page after the last (or at `index`); returns its id. */
export function addPage(ydoc: Y.Doc, index?: number, background = DEFAULT_PAGE_BACKGROUND): string {
  const rec = newPageRecord(background);
  localTx(ydoc, () => {
    const pages = getPages(ydoc);
    pages.insert(index ?? pages.length, [rec]);
  });
  return rec.get("id") as string;
}

/** Duplicate a page: copies the page record AND every element on it (fresh
 * ids, same page-local coordinates). Returns the new page id, or null when
 * `pageId` doesn't exist. */
export function duplicatePage(ydoc: Y.Doc, pageId: string): string | null {
  const pages = getPages(ydoc);
  const idx = projectPages(ydoc).findIndex((p) => p.id === pageId);
  if (idx < 0) return null;
  const src = pages.get(idx) as Y.Map<unknown>;
  const rec = newPageRecord(String(src.get("background") ?? DEFAULT_PAGE_BACKGROUND));
  const copies: BoardElement[] = [];
  getElements(ydoc).forEach((raw) => {
    if (raw.get("pageId") !== pageId) return;
    const parsed = BoardElementSchema.safeParse(Object.fromEntries(raw.entries()));
    if (parsed.success) copies.push(cloneElement(parsed.data, uid(), parsed.data.z));
  });
  localTx(ydoc, () => {
    pages.insert(idx + 1, [rec]);
    const target = rec.get("id") as string;
    for (const copy of copies) {
      insert(ydoc, { ...copy, pageId: target });
    }
  });
  return rec.get("id") as string;
}

/** Delete a page AND its elements in one transaction (one undo step restores
 * both). The last remaining page cannot be deleted. Returns false when this
 * was the last page or the id is unknown. */
export function deletePage(ydoc: Y.Doc, pageId: string): boolean {
  const ordered = projectPages(ydoc);
  const idx = ordered.findIndex((p) => p.id === pageId);
  if (idx < 0 || ordered.length <= 1) return false;
  const victims: string[] = [];
  getElements(ydoc).forEach((raw, id) => {
    if (raw.get("pageId") === pageId) victims.push(id);
  });
  localTx(ydoc, () => {
    const els = getElements(ydoc);
    for (const id of victims) els.delete(id);
    getPages(ydoc).delete(idx, 1);
  });
  return true;
}

/** Reorder: move the page at `from` to `to` (both indices in the CURRENT
 * ordering; `to` is the insertion index after removal is accounted for —
 * same convention as Array.toSpliced). The same Y.Map record is re-inserted,
 * so page identity survives the move. */
export function movePage(ydoc: Y.Doc, from: number, to: number): void {
  const pages = getPages(ydoc);
  const len = pages.length;
  if (from === to || from < 0 || from >= len) return;
  const rec = pages.get(from);
  if (!rec) return;
  const clamped = Math.max(0, Math.min(len - 1, to));
  localTx(ydoc, () => {
    pages.delete(from, 1);
    // After deletion, an insertion index past the removed slot shifts by one.
    const insertAt = to > from ? clamped - 1 : clamped;
    pages.insert(Math.max(0, Math.min(getPages(ydoc).length, insertAt)), [rec]);
  });
}

/** Set a page's background color (per-page, presentation notebooks). */
export function setPageBackground(ydoc: Y.Doc, pageId: string, background: string): void {
  const pages = getPages(ydoc);
  const idx = projectPages(ydoc).findIndex((p) => p.id === pageId);
  if (idx < 0) return;
  localTx(ydoc, () => {
    (pages.get(idx) as Y.Map<unknown>).set("background", background);
  });
}

/** Move elements to another page — IDENTITY-PRESERVING (ADR-0005): the same
 * element rows flip their `pageId` in one transaction (one undo entry);
 * coordinates are kept as-is since every page shares the same space. */
export function moveElementsToPage(ydoc: Y.Doc, ids: string[], pageId: string): void {
  localTx(ydoc, () => {
    const els = getElements(ydoc);
    for (const id of ids) {
      const yel = els.get(id);
      if (yel) yel.set("pageId", pageId);
    }
  });
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
