import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { getYjsProviderForRoom } from "@liveblocks/yjs";
import type { Room } from "@liveblocks/client";
import {
  addElement,
  addInkElement,
  addLineElement,
  bringToFront,
  deleteElement,
  duplicateElement,
  moveZBackward,
  moveZForward,
  projectBoard,
  sendToBack,
  updateElement,
} from "@comata/crdt";
import type { BoardElement, ElementPatch } from "@comata/elements";
import { liveblocksClient } from "../lib/liveblocks";
import type { Identity } from "../lib/identity";

export type ConnStatus = "connected" | "connecting" | "disconnected";

/** Shallow equality with array-aware comparison (ink points decode to fresh
 * arrays on every projection — compare element-wise). */
function sameElement(a: BoardElement, b: BoardElement): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const va = (a as Record<string, unknown>)[k];
    const vb = (b as Record<string, unknown>)[k];
    if (va === vb) continue;
    if (Array.isArray(va) && Array.isArray(vb)) {
      if (va.length !== vb.length) return false;
      let same = true;
      for (let i = 0; i < va.length; i++) {
        if (va[i] !== vb[i]) {
          same = false;
          break;
        }
      }
      if (same) continue;
    }
    return false;
  }
  return true;
}

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
    kind: "rect" | "ellipse" | "sticky" | "text" | "frame",
    x: number,
    y: number,
    opts?: { w?: number; h?: number },
  ) => BoardElement;
  addLineEl: (
    kind: "line" | "arrow",
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ) => BoardElement | null;
  addInkEl: (mode: "pen" | "highlighter", points: number[]) => BoardElement | null;
  updateEl: (id: string, patch: ElementPatch) => void;
  duplicateEl: (id: string) => string | null;
  bringElToFront: (id: string) => void;
  moveElForward: (id: string) => void;
  moveElBackward: (id: string) => void;
  sendElToBack: (id: string) => void;
  deleteEl: (id: string) => void;
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

/**
 * Wires a notebook room's Yjs doc (owned by the Liveblocks provider) to React state.
 * - elements: projected from the Yjs doc on every update (R1: geometry lives here)
 * - peers:    remote cursors + cameras via native presence (follow mode)
 * - status:   polled room connection state
 */
export function useBoard(roomId: string, identity: Identity): BoardApi {
  const [elements, setElements] = useState<BoardElement[]>([]);
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [peers, setPeers] = useState<Peer[]>([]);

  const roomRef = useRef<Room<Presence> | null>(null);
  const ydocRef = useRef<Y.Doc | null>(null);
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

    // Project with identity stabilization: an element keeps the same object
    // reference across updates unless its own fields changed. This is what
    // makes React.memo on ElementView actually skip re-renders (tldraw-style
    // per-shape memoization) instead of re-rendering every shape on any edit.
    const cache = new Map<string, BoardElement>();
    const project = () => {
      const next = projectBoard(ydoc);
      const out: BoardElement[] = [];
      for (const el of next) {
        const prev = cache.get(el.id);
        out.push(prev && sameElement(prev, el) ? prev : el);
      }
      cache.clear();
      for (const el of out) cache.set(el.id, el);
      setElements(out);
    };
    ydoc.on("update", project);
    project();

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
      setPeers(list);
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
      ydoc.off("update", project);
      leave();
      roomRef.current = null;
      ydocRef.current = null;
    };
  }, [roomId, identity]);

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
      kind: "rect" | "ellipse" | "sticky" | "text" | "frame",
      x: number,
      y: number,
      opts?: { w?: number; h?: number },
    ) => {
      const ydoc = ydocRef.current;
      if (!ydoc) throw new Error("board not ready");
      return addElement(ydoc, kind, x, y, opts);
    },
    [],
  );

  const addLineEl = useCallback(
    (kind: "line" | "arrow", x1: number, y1: number, x2: number, y2: number) => {
      const ydoc = ydocRef.current;
      return ydoc ? addLineElement(ydoc, kind, x1, y1, x2, y2) : null;
    },
    [],
  );

  const addInkEl = useCallback((mode: "pen" | "highlighter", points: number[]) => {
    const ydoc = ydocRef.current;
    if (!ydoc || points.length < 4) return null;
    return addInkElement(ydoc, mode, points);
  }, []);

  const updateEl = useCallback((id: string, patch: ElementPatch) => {
    if (ydocRef.current) updateElement(ydocRef.current, id, patch);
  }, []);

  const duplicateEl = useCallback((id: string) => {
    const ydoc = ydocRef.current;
    if (!ydoc) return null;
    const copy = duplicateElement(ydoc, id);
    return copy?.id ?? null;
  }, []);

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

  const getSnapshot = useCallback(() => {
    const ydoc = ydocRef.current;
    return ydoc ? Y.encodeStateAsUpdate(ydoc) : null;
  }, []);

  const applySnapshot = useCallback((bytes: Uint8Array) => {
    if (ydocRef.current) Y.applyUpdate(ydocRef.current, bytes);
  }, []);

  return {
    elements,
    status,
    peers,
    setCursor,
    setCameraPresence,
    setPresenting,
    addEl,
    addLineEl,
    addInkEl,
    updateEl,
    duplicateEl,
    bringElToFront,
    moveElForward,
    moveElBackward,
    sendElToBack,
    deleteEl,
    getSnapshot,
    applySnapshot,
  };
}
