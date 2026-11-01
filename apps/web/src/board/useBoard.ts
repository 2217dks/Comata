import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as Y from "yjs";
import { getYjsProviderForRoom } from "@liveblocks/yjs";
import type { Room } from "@liveblocks/client";
import {
  addElement,
  addInkElement,
  addLineElement,
  addPage,
  bringToFront,
  createUndoManager,
  deleteElement,
  deletePage,
  duplicateElement,
  duplicatePage,
  ensurePages,
  getElements,
  getPages,
  moveElementsToPage,
  movePage,
  moveZBackward,
  moveZForward,
  pasteElements,
  projectPages,
  RESTORE_ORIGIN,
  sendToBack,
  setPageBackground,
  updateElement,
  updateElements,
  type PageRecord,
} from "@comata/crdt";
import { BoardElementSchema, type BoardElement, type ElementPatch } from "@comata/elements";
import { liveblocksClient } from "../lib/liveblocks";
import type { Identity } from "../lib/identity";

export type ConnStatus = "connected" | "connecting" | "disconnected";

export type PeerCamera = { x: number; y: number; scale: number };

export type Peer = {
  connectionId: number;
  userId: string;
  name: string;
  color: string;
  x: number;
  y: number;
  camera: PeerCamera | null;
  presenting: boolean;
};

export type BoardApi = {
  elements: BoardElement[];
  status: ConnStatus;
  peers: Peer[];
  setCursor: (x: number, y: number) => void;
  setCameraPresence: (camera: PeerCamera) => void;
  setPresenting: (presenting: boolean) => void;
  addEl: (
    kind: "rect" | "ellipse" | "sticky" | "text" | "code" | "math" | "custom",
    x: number,
    y: number,
    opts?: { pageId?: string; w?: number; h?: number },
  ) => BoardElement;
  addLineEl: (
    kind: "line" | "arrow",
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    pageId?: string,
  ) => BoardElement | null;
  addInkEl: (mode: "pen" | "highlighter", points: number[], pageId?: string) => BoardElement | null;
  updateEl: (id: string, patch: ElementPatch) => void;
  /** Batched multi-element patch — ONE Yjs transaction for the whole set. */
  updateEls: (patches: { id: string; patch: ElementPatch }[]) => void;
  duplicateEl: (id: string) => string | null;
  pasteEls: (els: BoardElement[], offset: { x: number; y: number }, pageId?: string) => BoardElement[];
  /** Canva-style per-user history: undo/redo only ever touch THIS session's
   * changes (the manager tracks the local transaction origin exclusively). */
  undo: () => void;
  redo: () => void;
  /** Split the undo stack at a gesture boundary (call after a committed drag/
   * create/delete so the next gesture doesn't merge into it). */
  stopCapturing: () => void;
  bringElToFront: (id: string) => void;
  moveElForward: (id: string) => void;
  moveElBackward: (id: string) => void;
  sendElToBack: (id: string) => void;
  deleteEl: (id: string) => void;
  /** Ordered page list (presentation notebooks; [] for canvas docs). */
  pages: PageRecord[];
  /** Presentation notebooks: seed page 1 when the doc has none. Idempotent. */
  seedPages: () => void;
  addPage: (index?: number, background?: string) => string | null;
  duplicatePage: (pageId: string) => string | null;
  deletePage: (pageId: string) => boolean;
  movePage: (from: number, to: number) => void;
  setPageBackground: (pageId: string, background: string) => void;
  /** Identity-preserving cross-page move (ADR-0005). */
  moveElsToPage: (ids: string[], pageId: string) => void;
  getSnapshot: () => Uint8Array | null;
  applySnapshot: (bytes: Uint8Array) => void;
};

type Presence = {
  cursor: { x: number; y: number } | null;
  profile: { name: string; color: string };
  camera: PeerCamera | null;
  presenting: boolean;
};

type OtherUser = {
  connectionId?: number;
  user?: { id?: string };
  presence?: {
    cursor?: { x?: number; y?: number } | null;
    profile?: { name?: string; color?: string };
    camera?: PeerCamera | null;
    presenting?: boolean;
  };
};

// ── Cursor side-channel store ────────────────────────────────────────────────
// Remote cursor positions stream at 12-25 updates/sec per peer. Routing them
// through Board state re-rendered the ENTIRE board per mousemove per peer;
// instead, cursors live in this tiny external store and the CursorLayer
// component subscribes with useSyncExternalStore — only the cursor layer
// re-renders when a peer moves.
type CursorMap = Map<number, { name: string; color: string; x: number; y: number }>;
export type { CursorMap };
let cursorStore: CursorMap = new Map();
const cursorListeners = new Set<() => void>();
let cursorVersion = 0;

function publishCursors(peers: Peer[]): void {
  let changed = false;
  const next: CursorMap = new Map();
  for (const p of peers) {
    next.set(p.connectionId, { name: p.name, color: p.color, x: p.x, y: p.y });
    const prev = cursorStore.get(p.connectionId);
    if (!prev || prev.x !== p.x || prev.y !== p.y || prev.name !== p.name || prev.color !== p.color) changed = true;
  }
  if (cursorStore.size !== next.size) changed = true;
  if (!changed) return;
  cursorStore = next;
  cursorVersion++;
  for (const l of cursorListeners) l();
}

function subscribeCursors(l: () => void): () => void {
  cursorListeners.add(l);
  return () => cursorListeners.delete(l);
}

/** Snapshot for useSyncExternalStore — a version tag keeps the reference
 * stable across renders that didn't change any cursor. */
let lastSnapshot: { v: number; cursors: CursorMap } = { v: -1, cursors: cursorStore };
function getCursorSnapshot(): { v: number; cursors: CursorMap } {
  if (lastSnapshot.v !== cursorVersion) lastSnapshot = { v: cursorVersion, cursors: cursorStore };
  return lastSnapshot;
}

/** React binding for the remote-cursor side channel: a component using this
 * re-renders ONLY when some peer's cursor moved/changed identity — Board
 * itself never does. */
export function useRemoteCursors(): CursorMap {
  return useSyncExternalStore(subscribeCursors, getCursorSnapshot).cursors;
}

/**
 * Wires a notebook room's Yjs doc (owned by the Liveblocks provider) to React state.
 * - elements: projected from the Yjs doc on every update (R1: geometry lives here)
 * - peers:    remote cursors + cameras via native presence (follow mode)
 * - status:   polled room connection state
 */
export function useBoard(roomId: string, identity: Identity): BoardApi {
  const [elements, setElements] = useState<BoardElement[]>([]);
  const [pages, setPages] = useState<PageRecord[]>([]);
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [peers, setPeers] = useState<Peer[]>([]);

  const roomRef = useRef<Room<Presence> | null>(null);
  const ydocRef = useRef<Y.Doc | null>(null);
  const undoRef = useRef<Y.UndoManager | null>(null);
  const userIdRef = useRef(identity.id);
  const lastCursorSent = useRef(0);
  const lastCameraSent = useRef(0);

  useEffect(() => {
    const { room, leave } = liveblocksClient.enterRoom<Presence>(roomId, {
      initialPresence: {
        cursor: null,
        profile: { name: identity.name, color: identity.color },
        camera: null,
        presenting: false,
      },
    });
    roomRef.current = room;
    userIdRef.current = identity.id;

    const provider = getYjsProviderForRoom(room);
    const ydoc = provider.getYDoc();
    ydocRef.current = ydoc;

    // Page list projection: the pages Y.Array re-projects wholesale on any
    // change (page ops are rare — creation/reorder/delete — so no dirty-id
    // machinery is needed, unlike elements).
    const projectPagesNow = () => setPages(projectPages(ydoc));
    getPages(ydoc).observe(projectPagesNow);
    projectPagesNow();

    // Project with identity stabilization + dirty-id tracking: only elements
    // whose Y.Map actually changed get re-parsed (the Zod parse is the
    // expensive part), unchanged elements keep their object references so
    // memo(ElementView) skips re-render, and a projection with no visible
    // change skips setState entirely.
    const cache = new Map<string, BoardElement>();
    const dirty = new Set<string>();
    let dirtyAll = true;

    const parseElement = (id: string, raw: Y.Map<unknown>): BoardElement | null => {
      const parsed = BoardElementSchema.safeParse(Object.fromEntries(raw.entries()));
      return parsed.success ? parsed.data : null;
    };

    const project = () => {
      const ymap = getElements(ydoc);
      if (dirtyAll) {
        cache.clear();
        ymap.forEach((raw, id) => {
          const parsed = parseElement(id, raw);
          if (parsed) cache.set(id, parsed);
        });
        dirty.clear();
        dirtyAll = false;
      } else if (dirty.size > 0) {
        for (const id of dirty) {
          const raw = ymap.get(id);
          const parsed = raw ? parseElement(id, raw) : null;
          if (parsed) cache.set(id, parsed);
          else cache.delete(id);
        }
        dirty.clear();
      } else {
        return; // nothing changed — don't touch React state at all
      }
      const out = [...cache.values()].sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      setElements((prev) =>
        prev.length === out.length && prev.every((e, i) => e === out[i]) ? prev : out,
      );
    };

    const elementsMap = getElements(ydoc);
    const onDeep = (events: Y.YEvent<any>[]) => {
      for (const ev of events) {
        if (ev.path.length === 0) {
          // The elements map itself changed: add/delete of whole elements.
          for (const id of Array.from((ev as Y.YMapEvent<unknown>).changes.keys.keys())) {
            dirty.add(id);
          }
        } else if (typeof ev.path[0] === "string") {
          // A field inside one element changed.
          dirty.add(ev.path[0] as string);
        } else {
          dirtyAll = true;
        }
      }
      project();
    };
    elementsMap.observeDeep(onDeep);
    project();

    // Per-user undo/redo (Canva behavior): tracks only transactions with
    // LOCAL_ORIGIN, so remote edits never enter this session's undo stack.
    undoRef.current = createUndoManager(ydoc);

    const unsubOthers = room.subscribe("others", (ev: unknown) => {
      const others: OtherUser[] = Array.isArray(ev)
        ? (ev as OtherUser[])
        : ((ev as { others?: OtherUser[] } | null)?.others ?? []);
      const list: Peer[] = [];
      for (const other of others) {
        const cursor = other.presence?.cursor;
        const profile = other.presence?.profile;
        if (!profile?.name || !profile?.color) continue;
        list.push({
          connectionId: other.connectionId ?? 0,
          userId: other.user?.id ?? "",
          name: profile.name,
          color: profile.color,
          x: cursor?.x ?? 0,
          y: cursor?.y ?? 0,
          camera: other.presence?.camera ?? null,
          presenting: other.presence?.presenting === true,
        });
      }
      // Cursor-only updates (x/y moves) never touch Board state — the
      // side-channel store below owns them. setPeers fires only when a peer's
      // IDENTITY fields change (join/leave/rename/color/presenting/camera —
      // camera feeds follow mode), i.e. a few times per session, not 25/sec.
      setPeers((prev) => {
        if (prev.length !== list.length) return list;
        for (let i = 0; i < list.length; i++) {
          const a = prev[i];
          const b = list[i];
          if (!a || !b) return list;
          if (
            a.connectionId !== b.connectionId ||
            a.name !== b.name ||
            a.color !== b.color ||
            a.presenting !== b.presenting ||
            a.camera?.x !== b.camera?.x ||
            a.camera?.y !== b.camera?.y ||
            a.camera?.scale !== b.camera?.scale ||
            (a.camera === null) !== (b.camera === null)
          ) {
            return list;
          }
        }
        return prev; // cursor-only change — no Board re-render
      });
      publishCursors(list);
    });

    const statusTimer = setInterval(() => {
      const s = room.getStatus();
      setStatus(
        s === "connected" ? "connected" : s === "disconnected" ? "disconnected" : "connecting",
      );
    }, 500);

    return () => {
      clearInterval(statusTimer);
      unsubOthers();
      elementsMap.unobserveDeep(onDeep);
      getPages(ydoc).unobserve(projectPagesNow);
      undoRef.current?.destroy();
      undoRef.current = null;
      leave();
      roomRef.current = null;
      ydocRef.current = null;
    };
  }, [roomId, identity]);

  const undo = useCallback(() => {
    undoRef.current?.undo();
  }, []);
  const redo = useCallback(() => {
    undoRef.current?.redo();
  }, []);
  const stopCapturing = useCallback(() => {
    undoRef.current?.stopCapturing();
  }, []);

  const setCursor = useCallback((x: number, y: number) => {
    const now = Date.now();
    if (now - lastCursorSent.current < 40) return;
    lastCursorSent.current = now;
    roomRef.current?.updatePresence({ cursor: { x, y } });
  }, []);

  const setCameraPresence = useCallback((camera: PeerCamera) => {
    const now = Date.now();
    if (now - lastCameraSent.current < 60) return;
    lastCameraSent.current = now;
    roomRef.current?.updatePresence({ camera });
  }, []);

  const setPresenting = useCallback((presenting: boolean) => {
    roomRef.current?.updatePresence({ presenting });
  }, []);

  const addEl = useCallback(
    (
      kind: "rect" | "ellipse" | "sticky" | "text" | "code" | "math" | "custom",
      x: number,
      y: number,
      opts?: { pageId?: string; w?: number; h?: number },
    ) => {
      const ydoc = ydocRef.current;
      if (!ydoc) throw new Error("board not ready");
      return addElement(ydoc, kind, x, y, opts);
    },
    [],
  );

  const addLineEl = useCallback(
    (kind: "line" | "arrow", x1: number, y1: number, x2: number, y2: number, pageId?: string) => {
      const ydoc = ydocRef.current;
      return ydoc ? addLineElement(ydoc, kind, x1, y1, x2, y2, pageId) : null;
    },
    [],
  );

  const addInkEl = useCallback((mode: "pen" | "highlighter", points: number[], pageId?: string) => {
    const ydoc = ydocRef.current;
    if (!ydoc || points.length < 4) return null;
    return addInkElement(ydoc, mode, points, pageId);
  }, []);

  const updateEl = useCallback((id: string, patch: ElementPatch) => {
    if (ydocRef.current) updateElement(ydocRef.current, id, patch);
  }, []);

  const updateEls = useCallback((patches: { id: string; patch: ElementPatch }[]) => {
    const ydoc = ydocRef.current;
    if (ydoc) updateElements(ydoc, patches);
  }, []);

  const duplicateEl = useCallback((id: string) => {
    const ydoc = ydocRef.current;
    if (!ydoc) return null;
    const copy = duplicateElement(ydoc, id);
    return copy?.id ?? null;
  }, []);

  const pasteEls = useCallback(
    (els: BoardElement[], offset: { x: number; y: number }, pageId?: string) => {
      const ydoc = ydocRef.current;
      return ydoc ? pasteElements(ydoc, els, offset, pageId) : [];
    },
    [],
  );

  const bringElToFront = useCallback((id: string) => {
    if (ydocRef.current) bringToFront(ydocRef.current, id);
  }, []);

  const moveElForward = useCallback((id: string) => {
    if (ydocRef.current) moveZForward(ydocRef.current, id);
  }, []);

  const moveElBackward = useCallback((id: string) => {
    if (ydocRef.current) moveZBackward(ydocRef.current, id);
  }, []);

  const sendElToBack = useCallback((id: string) => {
    if (ydocRef.current) sendToBack(ydocRef.current, id);
  }, []);

  const deleteEl = useCallback((id: string) => {
    if (ydocRef.current) deleteElement(ydocRef.current, id);
  }, []);

  const seedPages = useCallback(() => {
    if (ydocRef.current) ensurePages(ydocRef.current);
  }, []);

  const addPageCb = useCallback((index?: number, background?: string) => {
    const ydoc = ydocRef.current;
    return ydoc ? addPage(ydoc, index, background) : null;
  }, []);

  const duplicatePageCb = useCallback((pageId: string) => {
    const ydoc = ydocRef.current;
    return ydoc ? duplicatePage(ydoc, pageId) : null;
  }, []);

  const deletePageCb = useCallback((pageId: string) => {
    const ydoc = ydocRef.current;
    return ydoc ? deletePage(ydoc, pageId) : false;
  }, []);

  const movePageCb = useCallback((from: number, to: number) => {
    const ydoc = ydocRef.current;
    if (ydoc) movePage(ydoc, from, to);
  }, []);

  const setPageBackgroundCb = useCallback((pageId: string, background: string) => {
    const ydoc = ydocRef.current;
    if (ydoc) setPageBackground(ydoc, pageId, background);
  }, []);

  const moveElsToPage = useCallback((ids: string[], pageId: string) => {
    const ydoc = ydocRef.current;
    if (ydoc) moveElementsToPage(ydoc, ids, pageId);
  }, []);

  const getSnapshot = useCallback(() => {
    const ydoc = ydocRef.current;
    return ydoc ? Y.encodeStateAsUpdate(ydoc) : null;
  }, []);

  const applySnapshot = useCallback((bytes: Uint8Array) => {
    // RESTORE_ORIGIN keeps bulk snapshot loads out of the local undo stack.
    if (ydocRef.current) Y.applyUpdate(ydocRef.current, bytes, RESTORE_ORIGIN);
  }, []);

  // Stable BoardApi identity: every callback is already useCallback'd with
  // stable deps, so memoizing the wrapper keeps Board's effects that depend
  // on `board` from re-running on every render.
  return useMemo(
    () => ({
      elements,
      pages,
      status,
      peers,
      setCursor,
      setCameraPresence,
      setPresenting,
      addEl,
      addLineEl,
      addInkEl,
      updateEl,
      updateEls,
      duplicateEl,
      pasteEls,
      undo,
      redo,
      stopCapturing,
      bringElToFront,
      moveElForward,
      moveElBackward,
      sendElToBack,
      deleteEl,
      seedPages,
      addPage: addPageCb,
      duplicatePage: duplicatePageCb,
      deletePage: deletePageCb,
      movePage: movePageCb,
      setPageBackground: setPageBackgroundCb,
      moveElsToPage,
      getSnapshot,
      applySnapshot,
    }),
    [
      elements,
      pages,
      status,
      peers,
      setCursor,
      setCameraPresence,
      setPresenting,
      addEl,
      addLineEl,
      addInkEl,
      updateEl,
      updateEls,
      duplicateEl,
      pasteEls,
      undo,
      redo,
      stopCapturing,
      bringElToFront,
      moveElForward,
      moveElBackward,
      sendElToBack,
      deleteEl,
      seedPages,
      addPageCb,
      duplicatePageCb,
      deletePageCb,
      movePageCb,
      setPageBackgroundCb,
      moveElsToPage,
      getSnapshot,
      applySnapshot,
    ],
  );
}
