import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { getYjsProviderForRoom } from "@liveblocks/yjs";
import type { Room } from "@liveblocks/client";
import { addRect, addSticky, bringToFront, moveElement, projectBoard } from "@comata/crdt";
import type { BoardElement } from "@comata/elements";
import { liveblocksClient } from "../lib/liveblocks";
import type { Identity } from "../lib/identity";

export type ConnStatus = "connected" | "connecting" | "disconnected";

export type Peer = { connectionId: number; name: string; color: string; x: number; y: number };

export type BoardApi = {
  elements: BoardElement[];
  status: ConnStatus;
  peers: Peer[];
  setCursor: (x: number, y: number) => void;
  addRectAt: (x: number, y: number) => void;
  addStickyAt: (x: number, y: number) => void;
  moveEl: (id: string, x: number, y: number) => void;
  bringElToFront: (id: string) => void;
  getSnapshot: () => Uint8Array | null;
  applySnapshot: (bytes: Uint8Array) => void;
};

type Presence = {
  cursor: { x: number; y: number } | null;
  profile: { name: string; color: string };
};

type OtherUser = {
  connectionId?: number;
  presence?: {
    cursor?: { x?: number; y?: number } | null;
    profile?: { name?: string; color?: string };
  };
};

/**
 * Wires a notebook room's Yjs doc (owned by the Liveblocks provider) to React state.
 * - elements: projected from the Yjs doc on every update (R1: geometry lives here)
 * - peers:    remote cursors via native presence
 * - status:   polled room connection state
 */
export function useBoard(roomId: string, identity: Identity): BoardApi {
  const [elements, setElements] = useState<BoardElement[]>([]);
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [peers, setPeers] = useState<Peer[]>([]);

  const roomRef = useRef<Room<Presence> | null>(null);
  const ydocRef = useRef<Y.Doc | null>(null);
  const lastCursorSent = useRef(0);

  useEffect(() => {
    const { room, leave } = liveblocksClient.enterRoom<Presence>(roomId, {
      initialPresence: {
        cursor: null,
        profile: { name: identity.name, color: identity.color },
      },
    });
    roomRef.current = room;

    const provider = getYjsProviderForRoom(room);
    const ydoc = provider.getYDoc();
    ydocRef.current = ydoc;

    const project = () => setElements(projectBoard(ydoc));
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
        if (
          cursor &&
          typeof cursor.x === "number" &&
          typeof cursor.y === "number" &&
          profile?.name &&
          profile?.color
        ) {
          list.push({
            connectionId: other.connectionId ?? 0,
            name: profile.name,
            color: profile.color,
            x: cursor.x,
            y: cursor.y,
          });
        }
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

  const addRectAt = useCallback((x: number, y: number) => {
    if (ydocRef.current) addRect(ydocRef.current, x, y);
  }, []);

  const addStickyAt = useCallback((x: number, y: number) => {
    if (ydocRef.current) addSticky(ydocRef.current, x, y);
  }, []);

  const moveEl = useCallback((id: string, x: number, y: number) => {
    if (ydocRef.current) moveElement(ydocRef.current, id, x, y);
  }, []);

  const bringElToFront = useCallback((id: string) => {
    if (ydocRef.current) bringToFront(ydocRef.current, id);
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
    addRectAt,
    addStickyAt,
    moveEl,
    bringElToFront,
    getSnapshot,
    applySnapshot,
  };
}
