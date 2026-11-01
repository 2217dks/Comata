// ── Draft preview store (perf: gestures must not re-render the Board) ───────
// In-progress gesture previews (marquee rect, lasso polyline, shape draft,
// ink stroke) used to live in Board useState — every pointermove re-rendered
// the whole board. They now live in this tiny external store; the DraftLayer
// component subscribes with useSyncExternalStore, so a drag re-renders only
// the draft layer.

import { useSyncExternalStore } from "react";
import type { Vec } from "./interactions";

export type DraftRect = { x: number; y: number; w: number; h: number };
export type DraftShape = { tool: string; start: Vec; current: Vec };

type DraftState = {
  marquee: DraftRect | null;
  lasso: Vec[] | null;
  ink: number[] | null;
  shape: DraftShape | null;
  /** Mode of the in-flight ink stroke (set at stroke start, read by the
   * preview renderer — highlighter draws translucent). */
  inkMode: "pen" | "highlighter";
};

let state: DraftState = { marquee: null, lasso: null, ink: null, shape: null, inkMode: "pen" };
const listeners = new Set<() => void>();
let version = 0;

function publish(patch: Partial<DraftState>): void {
  let changed = false;
  for (const k of Object.keys(patch) as (keyof DraftState)[]) {
    if (state[k] !== patch[k]) changed = true;
  }
  if (!changed) return;
  state = { ...state, ...patch };
  version++;
  for (const l of listeners) l();
}

/** Imperative handle the interaction handlers call (cheap, no React). */
export const draftStore = {
  setMarquee: (r: DraftRect | null) => publish({ marquee: r }),
  setLasso: (pts: Vec[] | null) => publish({ lasso: pts }),
  setInk: (pts: number[] | null, mode?: "pen" | "highlighter") =>
    publish(mode ? { ink: pts, inkMode: mode } : { ink: pts }),
  setShape: (d: DraftShape | null) => publish({ shape: d }),
  clearAll: () => publish({ marquee: null, lasso: null, ink: null, shape: null }),
  /** Read the current draft shape (create-commit path uses it). */
  get shape() {
    return state.shape;
  },
  get marquee() {
    return state.marquee;
  },
  get ink() {
    return state.ink;
  },
  get lasso() {
    return state.lasso;
  },
  get inkMode() {
    return state.inkMode;
  },
};

let snapshot: { v: number; s: DraftState } = { v: -1, s: state };
function getSnapshot(): { v: number; s: DraftState } {
  if (snapshot.v !== version) snapshot = { v: version, s: state };
  return snapshot;
}

/** React binding: re-renders ONLY when a preview actually changed. */
export function useDraftState(): DraftState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSnapshot,
  ).s;
}
