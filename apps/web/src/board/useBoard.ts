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
  getElements,
  moveZBackward,
  moveZForward,
  sendToBack,
  updateElement,
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
      const out = [...cache.values()].sort((a, b) => a.z - b.z || a.id.localeCompare(b.id));
      setElements((prev) =>
        prev.length === out.length && prev.every((e, i) => e === out[i]) ? prev : out,
      );
    };

    const elementsMap = getElements(ydoc);
    const onDeep = (events: Y.YEvent<unknown>[]) => {
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
      elementsMap.unobserveDeep(onDeep);
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
