import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";
import { Ellipse, Group, Label, Layer, Line, Path, Rect, Stage, Tag, Text, Transformer, Circle } from "react-konva";
import katex from "katex";
import "katex/dist/katex.min.css";
import type { BoardElement, ElementKind, ElementPatch, TextShape } from "@comata/elements";
import { ELEMENT_REGISTRY } from "@comata/elements";
import type { Identity } from "../lib/identity";
import type { BoardApi, ConnStatus, PeerCamera } from "./useBoard";
import { ElementView, hasMath, smoothInkPath } from "./ElementView";
import {
  DRAG_THRESHOLD,
  IDLE,
  bboxOf,
  elementsInLasso,
  elementsInRect,
  hitTestElement,
  normRect,
  type Interaction,
  type Rect as RectShape,
  type Vec,
} from "./interactions";

type Camera = { x: number; y: number; scale: number };
type Tool = "select" | "pen" | "highlighter" | "shape" | "line" | "arrow" | "text" | "sticky";
type ShapeVariant = "rect" | "ellipse";
type SelectMode = "marquee" | "lasso";

const CURSOR_ARROW = "M0 0 L0 17 L4.6 12.8 L7.4 19.6 L10.2 18.4 L7.4 11.8 L13 11.8 Z";

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;

const SWATCHES = ["#6c8cff", "#3ecf8e", "#f5b83d", "#ff6b6b", "#e7eaf0"];

const TOOL_KEYS: Record<string, { tool: Tool; variant?: ShapeVariant }> = {
  v: { tool: "select" },
  p: { tool: "pen" },
  h: { tool: "highlighter" },
  r: { tool: "shape", variant: "rect" },
  o: { tool: "shape", variant: "ellipse" },
  l: { tool: "line" },
  a: { tool: "arrow" },
  t: { tool: "text" },
  s: { tool: "sticky" },
};

const STATUS_CLASS: Record<ConnStatus, string> = {
  connected: "pill-online",
  connecting: "pill-checking",
  disconnected: "pill-offline",
};

const STATUS_LABEL: Record<ConnStatus, string> = {
  connected: "Live",
  connecting: "Connecting…",
  disconnected: "Offline",
};

const TOOL_HINTS: Partial<Record<Tool, string>> = {
  pen: "Draw with the pen — even a single click leaves a dot",
  highlighter: "Draw to highlight — sits translucently over content",
  shape: "Drag to size the shape — stacks over anything; click reverts to Select",
  line: "Drag to draw a line — click reverts to Select",
  arrow: "Drag to draw an arrow — click reverts to Select",
  text: "Click to place text — over anything; drag to size the box",
  sticky: "Click to place a sticky note — or double-click empty canvas",
};

/** Per-tool creation defaults (Figma-style: the properties bar edits these
 * when a creation tool is active and nothing is selected). */
type ToolDefaults = {
  pen: StrokeStyle;
  highlighter: StrokeStyle;
  shape: { fill: string } & StrokeStyle;
  line: StrokeStyle;
  text: FillStyle;
};

const DEFAULT_TOOL_DEFAULTS: ToolDefaults = {
  pen: { stroke: "#e7eaf0", strokeWidth: 2.5 },
  highlighter: { stroke: "#f5b83d", strokeWidth: 14 },
  shape: { fill: "#6c8cff", stroke: "#e7eaf0", strokeWidth: 0 },
  line: { stroke: "#e7eaf0", strokeWidth: 2 },
  text: { fill: "#e7eaf0" },
};

function useWindowSize(): { w: number; h: number } {
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

// ── Shared property controls (element inspector AND tool defaults) ──────────

function PropGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="prop-group">
      <span className="prop-label">{label}</span>
      {children}
    </span>
  );
}

type FillStyle = { fill: string };
type StrokeStyle = { stroke: string; strokeWidth: number };

function FillControls({
  value,
  onChange,
}: {
  value: string;
  onChange: (fill: string) => void;
}) {
  return (
    <PropGroup label="Fill">
      {SWATCHES.map((c) => (
        <button
          key={c}
          className={`swatch-mini ${value === c ? "active" : ""}`}
          style={{ background: c }}
          title={`Fill ${c}`}
          onClick={() => onChange(c)}
        />
      ))}
      <input type="color" value={value} title="Custom fill color" onChange={(e) => onChange(e.target.value)} />
    </PropGroup>
  );
}

function StrokeControls({ value, onChange }: { value: StrokeStyle; onChange: (v: StrokeStyle) => void }) {
  return (
    <PropGroup label="Border">
      <input
        type="color"
        value={value.stroke}
        title="Border color"
        onChange={(e) => onChange({ ...value, stroke: e.target.value })}
      />
      <input
        type="range"
        className="range"
        min={0}
        max={24}
        step={0.5}
        value={value.strokeWidth}
        title={`Border width ${value.strokeWidth}${value.strokeWidth === 0 ? " (none)" : ""}`}
        onChange={(e) => onChange({ ...value, strokeWidth: Number(e.target.value) })}
      />
      <span className="prop-value">{value.strokeWidth === 0 ? "none" : value.strokeWidth}</span>
    </PropGroup>
  );
}

function OpacityControls({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <PropGroup label="Opacity">
      <input
        type="range"
        className="range"
        min={10}
        max={100}
        value={Math.round(value * 100)}
        title={`Opacity ${Math.round(value * 100)}%`}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
      />
      <span className="prop-value">{Math.round(value * 100)}%</span>
    </PropGroup>
  );
}

function PropertiesBar({
  selectedEl,
  tool,
  shapeVariant,
  toolDefaults,
  setToolDefaults,
  updateEl,
  onEditText,
}: {
  selectedEl: BoardElement | null;
  tool: Tool;
  shapeVariant: ShapeVariant;
  toolDefaults: ToolDefaults;
  setToolDefaults: React.Dispatch<React.SetStateAction<ToolDefaults>>;
  updateEl: (id: string, patch: ElementPatch) => void;
  onEditText: () => void;
}) {
  // Figma rule: with a selection, edits apply to it; with a creation tool
  // active and nothing selected, edits change the tool's defaults.
  if (selectedEl) {
    const meta = ELEMENT_REGISTRY[selectedEl.kind];
    const id = selectedEl.id;
    return (
      <div className="props-bar">
        <span className="props-kind">{meta.label}</span>
        {meta.props.includes("fill") && (
          <FillControls value={selectedEl.fill} onChange={(fill) => updateEl(id, { fill })} />
        )}
        {meta.props.includes("stroke") && "stroke" in selectedEl && (
          <StrokeControls
            value={{ stroke: selectedEl.stroke, strokeWidth: selectedEl.strokeWidth }}
            onChange={(v) => updateEl(id, v)}
          />
        )}
        {meta.props.includes("strokeAlign") && "strokeAlign" in selectedEl && (
          <PropGroup label="Border align">
            <button
              className={`toggle ${selectedEl.strokeAlign === "outer" ? "active" : ""}`}
              title="Border outside the edge"
              onClick={() => updateEl(id, { strokeAlign: "outer" })}
            >
              Out
            </button>
            <button
              className={`toggle ${selectedEl.strokeAlign === "middle" ? "active" : ""}`}
              title="Border centered on the edge"
              onClick={() => updateEl(id, { strokeAlign: "middle" })}
            >
              Mid
            </button>
            <button
              className={`toggle ${selectedEl.strokeAlign === "inner" ? "active" : ""}`}
              title="Border inside the edge"
              onClick={() => updateEl(id, { strokeAlign: "inner" })}
            >
              In
            </button>
          </PropGroup>
        )}
        {meta.props.includes("fontSize") && selectedEl.kind === "text" && (
          <PropGroup label="Size">
            <input
              type="range"
              className="range"
              min={10}
              max={96}
              value={selectedEl.fontSize}
              title={`Font size ${selectedEl.fontSize}`}
              onChange={(e) => updateEl(id, { fontSize: Number(e.target.value) })}
            />
            <span className="prop-value">{selectedEl.fontSize}px</span>
          </PropGroup>
        )}
        {meta.props.includes("textStyle") && selectedEl.kind === "text" && (
          <PropGroup label="Style">
            <button
              className={`toggle ${selectedEl.bold ? "active" : ""}`}
              title="Bold"
              onClick={() => updateEl(id, { bold: !selectedEl.bold })}
            >
              B
            </button>
            <button
              className={`toggle ${selectedEl.italic ? "active" : ""}`}
              title="Italic"
              onClick={() => updateEl(id, { italic: !selectedEl.italic })}
            >
              I
            </button>
          </PropGroup>
        )}
        {meta.props.includes("align") && selectedEl.kind === "text" && (
          <>
            <PropGroup label="Align">
              <button
                className={`toggle ${selectedEl.align === "left" ? "active" : ""}`}
                title="Align left"
                onClick={() => updateEl(id, { align: "left" })}
              >
                L
              </button>
              <button
                className={`toggle ${selectedEl.align === "center" ? "active" : ""}`}
                title="Align center"
                onClick={() => updateEl(id, { align: "center" })}
              >
                C
              </button>
              <button
                className={`toggle ${selectedEl.align === "right" ? "active" : ""}`}
                title="Align right"
                onClick={() => updateEl(id, { align: "right" })}
              >
                R
              </button>
            </PropGroup>
            <PropGroup label="Vertical">
              <button
                className={`toggle ${selectedEl.valign === "top" ? "active" : ""}`}
                title="Align top"
                onClick={() => updateEl(id, { valign: "top" })}
              >
                T
              </button>
              <button
                className={`toggle ${selectedEl.valign === "middle" ? "active" : ""}`}
                title="Align middle"
                onClick={() => updateEl(id, { valign: "middle" })}
              >
                M
              </button>
              <button
                className={`toggle ${selectedEl.valign === "bottom" ? "active" : ""}`}
                title="Align bottom"
                onClick={() => updateEl(id, { valign: "bottom" })}
              >
                B
              </button>
            </PropGroup>
          </>
        )}
        {(selectedEl.kind === "text" || selectedEl.kind === "sticky") && (
          <button className="prop-action" onClick={onEditText}>
            ✎ Edit text
          </button>
        )}
        {meta.props.includes("opacity") && (
          <OpacityControls
            value={selectedEl.opacity}
            onChange={(opacity) => updateEl(id, { opacity })}
          />
        )}
      </div>
    );
  }

  if (tool === "pen" || tool === "highlighter") {
    const key = tool;
    return (
      <div className="props-bar">
        <span className="props-kind">{tool === "pen" ? "Pen" : "Highlighter"}</span>
        <StrokeControls
          value={{ stroke: toolDefaults[key].stroke, strokeWidth: toolDefaults[key].strokeWidth }}
          onChange={(v) => setToolDefaults((d) => ({ ...d, [key]: v }))}
        />
      </div>
    );
  }
  if (tool === "line" || tool === "arrow") {
    return (
      <div className="props-bar">
        <span className="props-kind">{tool === "line" ? "Line" : "Arrow"}</span>
        <StrokeControls
          value={toolDefaults.line}
          onChange={(v) => setToolDefaults((d) => ({ ...d, line: v }))}
        />
      </div>
    );
  }
  if (tool === "shape") {
    return (
      <div className="props-bar">
        <span className="props-kind">{shapeVariant === "ellipse" ? "Shape · Ellipse" : "Shape · Rectangle"}</span>
        <FillControls
          value={toolDefaults.shape.fill}
          onChange={(fill) => setToolDefaults((d) => ({ ...d, shape: { ...d.shape, fill } }))}
        />
        <StrokeControls
          value={{ stroke: toolDefaults.shape.stroke, strokeWidth: toolDefaults.shape.strokeWidth }}
          onChange={(v) => setToolDefaults((d) => ({ ...d, shape: { ...d.shape, ...v } }))}
        />
      </div>
    );
  }
  if (tool === "text") {
    return (
      <div className="props-bar">
        <span className="props-kind">Text</span>
        <FillControls
          value={toolDefaults.text.fill}
          onChange={(fill) => setToolDefaults((d) => ({ ...d, text: { fill } }))}
        />
      </div>
    );
  }
  if (tool === "sticky") {
    return <span className="props-hint">{TOOL_HINTS.sticky}</span>;
  }
  return null;
}

// ── Board ────────────────────────────────────────────────────────────────────

export function Board({
  board,
  identity,
  title,
  kind = "canvas",
  readOnly = false,
}: {
  board: BoardApi;
  identity: Identity;
  title?: string;
  /** Presentation notebooks get Present mode; canvas notebooks never show it. */
  kind?: "canvas" | "presentation";
  readOnly?: boolean;
}) {
  const stageRef = useRef<Konva.Stage | null>(null);
  const trRef = useRef<Konva.Transformer | null>(null);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 });
  const [tool, setTool] = useState<Tool>("select");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [toolDefaults, setToolDefaults] = useState<ToolDefaults>(DEFAULT_TOOL_DEFAULTS);
  /** Combined shape tool (Figma): one dock button, variant switched via its
   * sub-popup (or R / O shortcuts). */
  const [shapeVariant, setShapeVariant] = useState<ShapeVariant>("rect");
  /** Select-tool variant: rectangle select or freehand lasso. */
  const [selectMode, setSelectMode] = useState<SelectMode>("marquee");
  const [flyout, setFlyout] = useState<Tool | null>(null);

  // ── Pointer state machine (tldraw model: one interaction owns the pointer) ──
  const interactionRef = useRef<Interaction>(IDLE);
  const downScreenRef = useRef<Vec>({ x: 0, y: 0 });
  const movedRef = useRef(0); // screen-px travel since pointerdown
  const spaceRef = useRef(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);

  // Live previews (render-only mirrors of the machine state).
  const [draftInk, setDraftInk] = useState<number[] | null>(null);
  const inkPtsRef = useRef<number[] | null>(null);
  const [draft, setDraft] = useState<{ tool: Tool; start: Vec; current: Vec } | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<RectShape | null>(null);
  const [lassoPts, setLassoPts] = useState<Vec[] | null>(null);
  const moveSentRef = useRef(0); // throttle for machine-driven group moves

  // Present + follow mode.
  const [present, setPresent] = useState(false);
  const [presentIndex, setPresentIndex] = useState(0);
  const prePresentCamera = useRef<Camera | null>(null);
  const [followConn, setFollowConn] = useState<number | null>(null);

  const size = useWindowSize();
  const {
    setCameraPresence,
    setPresenting,
    duplicateEl,
    updateEl,
    deleteEl,
    bringElToFront,
    moveElForward,
    moveElBackward,
    sendElToBack,
    addEl,
    addLineEl,
    addInkEl,
  } = board;

  /** Deep-select (Excalidraw): clicking the selected element again cycles to
   * the next clickable element underneath the pointer. Ink is excluded —
   * strokes are only selectable via marquee. */
  const handleSelect = (id: string) => {
    const pointer = stageRef.current?.getPointerPosition();
    if (!pointer) {
      setSelectedIds([id]);
      return;
    }
    const world = toWorld(pointer.x, pointer.y);
    const current = selectedIds.length === 1 ? selectedIds[0] : null;
    // Shape-aware hits: lines/arrows answer to their stroke, not their bbox.
    const hits = board.elements.filter(
      (el) => el.kind !== "ink" && hitTestElement(el, world, 6 / camera.scale),
    );
    if (id === current && hits.length > 1) {
      const idx = hits.findIndex((h) => h.id === id);
      const below = hits[(idx - 1 + hits.length) % hits.length] as BoardElement;
      setSelectedIds([below.id]);
    } else {
      setSelectedIds([id]);
    }
  };

  const frames = useMemo(() => board.elements.filter((el) => el.kind === "frame"), [board.elements]);
  const selectedEl = useMemo(
    () => (selectedIds.length === 1 ? board.elements.find((el) => el.id === selectedIds[0]) ?? null : null),
    [board.elements, selectedIds],
  );

  // Stable callbacks for ElementView (memoized) — latest logic lives in refs.
  const onEditRef = useRef<(id: string) => void>(() => {});
  const onEditCb = useCallback((id: string) => onEditRef.current(id), []);
  const onTransformCb = useCallback((id: string, patch: ElementPatch) => updateEl(id, patch), [updateEl]);
  const presenter = useMemo(() => board.peers.find((p) => p.presenting) ?? null, [board.peers]);
  const followPeer = useMemo(
    () => board.peers.find((p) => p.connectionId === followConn) ?? null,
    [board.peers, followConn],
  );
  const ctxEl = useMemo(
    () => (ctxMenu ? board.elements.find((el) => el.id === ctxMenu.id) ?? null : null),
    [board.elements, ctxMenu],
  );

  const toWorld = (sx: number, sy: number) => ({
    x: (sx - camera.x) / camera.scale,
    y: (sy - camera.y) / camera.scale,
  });

  const toScreen = (wx: number, wy: number) => ({
    x: wx * camera.scale + camera.x,
    y: wy * camera.scale + camera.y,
  });

  // Safari trackpad pinch fires gesturestart/gesturechange — stop page zoom.
  useEffect(() => {
    const block = (e: Event) => e.preventDefault();
    document.addEventListener("gesturestart", block);
    document.addEventListener("gesturechange", block);
    return () => {
      document.removeEventListener("gesturestart", block);
      document.removeEventListener("gesturechange", block);
    };
  }, []);

  // Broadcast our camera via presence (debounced) — the payload follow mode reads.
  useEffect(() => {
    const t = window.setTimeout(() => setCameraPresence(camera), 80);
    return () => window.clearTimeout(t);
  }, [camera, setCameraPresence]);

  // Follow mode: mirror the followed peer's camera as their presence updates.
  useEffect(() => {
    if (followConn === null) return;
    const peer = board.peers.find((p) => p.connectionId === followConn);
    if (peer?.camera) setCamera(peer.camera);
  }, [board.peers, followConn]);

  // Close popovers on outside pointer-down.
  useEffect(() => {
    if (!showInfo && !ctxMenu && !flyout) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".info-popover") && !t.closest(".info-btn")) setShowInfo(false);
      if (!t.closest(".ctx-menu")) setCtxMenu(null);
      if (!t.closest(".tool-flyout") && !t.closest(".tool-btn")) setFlyout(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [showInfo, ctxMenu, flyout]);

  const breakFollow = () => setFollowConn(null);

  // Keyboard: tool shortcuts, delete/duplicate, Escape, present navigation.
  const nextFrame = () => setPresentIndex((i) => Math.min(frames.length - 1, i + 1));
  const prevFrame = () => setPresentIndex((i) => Math.max(0, i - 1));

  const exitPresent = () => {
    setPresent(false);
    setPresenting(false);
    if (prePresentCamera.current) setCamera(prePresentCamera.current);
  };

  const enterPresent = () => {
    if (readOnly || kind !== "presentation" || frames.length === 0) return;
    prePresentCamera.current = camera;
    setFollowConn(null);
    setSelectedIds([]);
    setEditing(null);
    setCtxMenu(null);
    setPresent(true);
    setPresentIndex(0);
    setPresenting(true);
  };

  const duplicateSelected = () => {
    if (selectedIds.length === 0) return;
    const nids = selectedIds.map((id) => duplicateEl(id)).filter((n): n is string => n !== null);
    if (nids.length > 0) setSelectedIds(nids);
  };

  const deleteSelected = () => {
    if (selectedIds.length === 0) return;
    for (const id of selectedIds) deleteEl(id);
    setSelectedIds([]);
    setEditing(null);
  };

  const cancelInteraction = () => {
    interactionRef.current = IDLE;
    inkPtsRef.current = null;
    setPanning(false);
    setDraftInk(null);
    setDraft(null);
    setMarqueeRect(null);
    setLassoPts(null);
  };

  const switchTool = (next: Tool, variant?: ShapeVariant) => {
    cancelInteraction();
    setFlyout(null);
    setTool(next);
    if (variant) setShapeVariant(variant);
    // Drawing tools start clean (Excalidraw/tldraw clear the selection).
    if (next !== "select") setSelectedIds([]);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;

      // Space = temporary pan (tldraw/Excalidraw), unless presenting.
      if (e.code === "Space" && !present) {
        spaceRef.current = true;
        setSpaceHeld(true);
        e.preventDefault();
        return;
      }

      if (e.key === "Escape") {
        // Esc first cancels the in-progress draft (Excalidraw behavior).
        if (interactionRef.current.kind !== "idle") {
          cancelInteraction();
          return;
        }
        if (ctxMenu) setCtxMenu(null);
        else if (showInfo) setShowInfo(false);
        else if (present) exitPresent();
        else if (selectedIds.length > 0) setSelectedIds([]);
        else switchTool("select");
        return;
      }

      // Viewers can watch, pan, clear selections, and navigate present mode —
      // but never mutate the board.
      if (readOnly) return;

      if (e.key === "]" && selectedIds.length === 1) {
        moveElForward(selectedIds[0] as string);
        return;
      }
      if (e.key === "[" && selectedIds.length === 1) {
        moveElBackward(selectedIds[0] as string);
        return;
      }

      if (present) {
        if (e.key === "ArrowRight" || e.key === "PageDown") {
          e.preventDefault();
          nextFrame();
        } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
          e.preventDefault();
          prevFrame();
        }
        return;
      }

      if ((e.metaKey || e.ctrlKey) && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        duplicateSelected();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "Backspace" || e.key === "Delete") {
        if (selectedIds.length > 0) {
          e.preventDefault();
          deleteSelected();
        }
        return;
      }
      const next = TOOL_KEYS[e.key.toLowerCase()];
      if (next) switchTool(next.tool, next.variant);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceRef.current = false;
        setSpaceHeld(false);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [present, presentIndex, frames.length, selectedIds, readOnly, ctxMenu, showInfo, duplicateEl, deleteEl, moveElForward, moveElBackward, board]);

  // Attach the Transformer to all selected resizable nodes — with multiple
  // selections Konva draws one combined bounding box that scales them all.
  // Single lines/arrows are excluded: they get Canva-style ENDPOINT handles
  // (no rectangular selection overlay) instead.
  const selectedLineEl =
    selectedEl && (selectedEl.kind === "line" || selectedEl.kind === "arrow") ? selectedEl : null;

  const trIds = useMemo(
    () =>
      selectedIds.filter((id) => {
        const el = board.elements.find((e2) => e2.id === id);
        if (!el || !ELEMENT_REGISTRY[el.kind].resizable) return false;
        if (selectedIds.length === 1 && (el.kind === "line" || el.kind === "arrow")) return false;
        return true;
      }),
    [selectedIds, board.elements],
  );
  useEffect(() => {
    const tr = trRef.current;
    const stage = stageRef.current;
    if (!tr || !stage) return;
    const nodes = trIds
      .map((id) => stage.findOne<Konva.Node>("#" + id))
      .filter((n): n is Konva.Node => n !== null);
    tr.nodes(nodes);
    tr.getLayer()?.batchDraw();
  }, [trIds, board.elements]);

  // Present camera: fit the active frame to the viewport.
  useEffect(() => {
    if (!present) return;
    const frame = frames[presentIndex];
    if (!frame) return;
    const scale = Math.min(size.w / (frame.w + 140), size.h / (frame.h + 180), 2);
    setCamera({
      scale,
      x: size.w / 2 - (frame.x + frame.w / 2) * scale,
      y: size.h / 2 - (frame.y + frame.h / 2) * scale,
    });
  }, [present, presentIndex, frames, size]);

  const handleWheel = (e: KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    breakFollow();
    const unit = e.evt.deltaMode === 1 ? 16 : e.evt.deltaMode === 2 ? 100 : 1;
    const dx = e.evt.deltaX * unit;
    const dy = e.evt.deltaY * unit;

    // Pinch (ctrl+wheel on trackpads) → zoom anchored at the pointer.
    if (e.evt.ctrlKey || e.evt.metaKey) {
      const pointer = stageRef.current?.getPointerPosition();
      if (!pointer) return;
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, camera.scale * Math.exp(-dy * 0.01)));
      const world = toWorld(pointer.x, pointer.y);
      setCamera({ scale, x: pointer.x - world.x * scale, y: pointer.y - world.y * scale });
      return;
    }

    // Two-finger scroll → pan up/down/left/right (Figma-style).
    setCamera((c) => ({ ...c, x: c.x - dx, y: c.y - dy }));
  };

  const zoomAtCenter = (scale: number) => {
    breakFollow();
    const cx = size.w / 2;
    const cy = size.h / 2;
    const world = toWorld(cx, cy);
    setCamera({ scale, x: cx - world.x * scale, y: cy - world.y * scale });
  };

  // ── Pointer state machine (tldraw model) ─────────────────────────────────
  // pointerdown picks the interaction; pointermove feeds it; window mouseup
  // commits it. The camera NEVER moves by click-drag — panning is two-finger
  // scroll, space-drag, or middle-drag.

  const getPointer = () => stageRef.current?.getPointerPosition() ?? null;

  const isOverTransformer = (node: Konva.Node | null): boolean => {
    const tr = trRef.current;
    if (!tr) return false;
    let n: Konva.Node | null = node;
    while (n) {
      if (n === tr) return true;
      n = n.getParent();
    }
    return false;
  };

  // Canva-style endpoint editing for lines/arrows: dragging a handle rewrites
  // the geometry live. The fixed anchor comes from the render-scope element
  // (it never moves during the drag), the moving end from the handle node —
  // w/h are signed offsets, so dragging to any direction just works.
  // Handles live on the untransformed selection layer → screen coords in,
  // world coords out via toWorld.
  const dragLineEndpoint =
    (el: BoardElement, end: "start" | "end") => (e: KonvaEventObject<DragEvent>) => {
      const p = toWorld(e.target.x(), e.target.y());
      if (end === "start") {
        updateEl(el.id, { x: p.x, y: p.y, w: el.x + el.w - p.x, h: el.y + el.h - p.y });
      } else {
        updateEl(el.id, { w: p.x - el.x, h: p.y - el.y });
      }
    };

  const handleMouseDown = (e: KonvaEventObject<MouseEvent>) => {
    if (readOnly || present) return;
    const btn = e.evt.button;
    const pointer = getPointer();
    if (!pointer) return;

    // Middle-drag or space-drag pans from any tool (Excalidraw/tldraw).
    if (btn === 1 || (spaceRef.current && btn === 0)) {
      e.evt.preventDefault();
      interactionRef.current = { kind: "pan", lastScreen: { x: pointer.x, y: pointer.y } };
      setPanning(true);
      return;
    }
    if (btn !== 0) return;

    // Transformer handles own their events — never start an interaction on them.
    if (isOverTransformer(e.target)) return;
    // Line/arrow endpoint handles are Konva-draggable UI — they own their drags.
    if (e.target.name() === "endpoint-handle") return;

    const world = toWorld(pointer.x, pointer.y);
    downScreenRef.current = { x: pointer.x, y: pointer.y };
    movedRef.current = 0;

    if (tool === "select") {
      // 3-state model on elements (tldraw): press records intent; drag moves
      // the whole originating selection; release-without-move click-selects.
      let elNode: Konva.Node | null = e.target;
      while (elNode && elNode.name() !== "element") elNode = elNode.getParent();
      if (elNode) {
        const id = elNode.id();
        const el = board.elements.find((e2) => e2.id === id);
        if (el) {
          const wasInSelection = selectedIds.includes(id);
          if (!wasInSelection) setSelectedIds([id]);
          const moveIds = wasInSelection ? selectedIds : [id];
          const orig = moveIds
            .map((selId) => board.elements.find((e2) => e2.id === selId))
            .filter((e2): e2 is BoardElement => e2 !== undefined)
            .map((e2) => ({ id: e2.id, x: e2.x, y: e2.y }));
          interactionRef.current = { kind: "pointShape", id, wasInSelection, startWorld: world, orig };
        }
        return;
      }
      if (e.target.name() === "pan") {
        // Press inside the current selection's bounding box (the empty gaps
        // BETWEEN selected elements)? That's the selection background: drag
        // moves the whole selection, a bare click keeps it (tldraw behavior).
        const sel = selectedIds
          .map((sid) => board.elements.find((e2) => e2.id === sid))
          .filter((e2): e2 is BoardElement => e2 !== undefined);
        const pad = 4 / camera.scale;
        const boxes = sel.map((s) => bboxOf(s));
        const minX = Math.min(...boxes.map((b) => b.x)) - pad;
        const minY = Math.min(...boxes.map((b) => b.y)) - pad;
        const maxX = Math.max(...boxes.map((b) => b.x + b.w)) + pad;
        const maxY = Math.max(...boxes.map((b) => b.y + b.h)) + pad;
        if (sel.length > 0 && world.x >= minX && world.x <= maxX && world.y >= minY && world.y <= maxY) {
          interactionRef.current = {
            kind: "pointShape",
            id: null,
            wasInSelection: true,
            startWorld: world,
            orig: sel.map((s) => ({ id: s.id, x: s.x, y: s.y })),
          };
          return;
        }
        // Empty canvas: press starts a rectangle select or a lasso (clears
        // the selection).
        setSelectedIds([]);
        if (selectMode === "lasso") {
          interactionRef.current = { kind: "lasso", points: [world] };
          setLassoPts([world]);
        } else {
          interactionRef.current = { kind: "marquee", startWorld: world };
          setMarqueeRect({ x: world.x, y: world.y, w: 0, h: 0 });
        }
      }
      return;
    }

    if (tool === "pen" || tool === "highlighter") {
      inkPtsRef.current = [world.x, world.y];
      setDraftInk([world.x, world.y]);
      interactionRef.current = { kind: "ink", mode: tool };
      return;
    }

    // shape / line / arrow / sticky / text — create-drag or click.
    // Creation tools capture the whole canvas (elements are non-interactive),
    // so creating over other elements always works — Figma layering.
    interactionRef.current = { kind: "create", tool, startWorld: world };
    setDraft({ tool, start: world, current: world });
  };

  const handleMouseMove = () => {
    const pointer = getPointer();
    if (!pointer) return;
    const world = toWorld(pointer.x, pointer.y);
    board.setCursor(world.x, world.y);

    movedRef.current = Math.max(
      movedRef.current,
      Math.hypot(pointer.x - downScreenRef.current.x, pointer.y - downScreenRef.current.y),
    );

    const it = interactionRef.current;
    switch (it.kind) {
      case "idle":
        return;
      case "pan": {
        const dx = pointer.x - it.lastScreen.x;
        const dy = pointer.y - it.lastScreen.y;
        it.lastScreen = { x: pointer.x, y: pointer.y };
        setCamera((c) => ({ ...c, x: c.x + dx, y: c.y + dy }));
        return;
      }
      case "marquee": {
        setMarqueeRect(normRect(it.startWorld, world));
        return;
      }
      case "lasso": {
        const pts = it.points;
        const last = pts[pts.length - 1] as Vec;
        const lastScreen = toScreen(last.x, last.y);
        if (Math.hypot(pointer.x - lastScreen.x, pointer.y - lastScreen.y) < 4) return;
        pts.push(world);
        setLassoPts([...pts]);
        return;
      }
      case "pointShape": {
        // Move the whole originating selection (throttled CRDT writes — the
        // local doc echoes synchronously, so motion stays smooth).
        if (movedRef.current <= DRAG_THRESHOLD) return;
        const dx = world.x - it.startWorld.x;
        const dy = world.y - it.startWorld.y;
        const now = performance.now();
        if (now - moveSentRef.current < 30) return;
        moveSentRef.current = now;
        for (const o of it.orig) updateEl(o.id, { x: o.x + dx, y: o.y + dy });
        // Prop-driven moves don't emit Konva drag events — re-sync handles.
        trRef.current?.forceUpdate();
        return;
      }
      case "ink": {
        const pts = inkPtsRef.current;
        if (!pts) return;
        const lastX = pts[pts.length - 2] as number;
        const lastY = pts[pts.length - 1] as number;
        const minDist = 2 / camera.scale; // point thinning in screen space
        if (Math.hypot(world.x - lastX, world.y - lastY) < minDist) return;
        // Light exponential smoothing tames trackpad jitter before commit.
        const a = 0.75;
        pts.push(lastX + (world.x - lastX) * a, lastY + (world.y - lastY) * a);
        setDraftInk([...pts]);
        return;
      }
      case "create": {
        setDraft({ tool: it.tool, start: it.startWorld, current: world });
        return;
      }
    }
  };

  // Commits run on window mouseup — releases outside the stage still finish.
  const finishRef = useRef<() => void>(() => {});
  finishRef.current = () => {
    const it = interactionRef.current;
    interactionRef.current = IDLE;
    setPanning(false);
    const pointer = getPointer();

    switch (it.kind) {
      case "idle":
      case "pan":
        return;

      case "marquee": {
        setMarqueeRect(null);
        if (!pointer) return;
        const end = toWorld(pointer.x, pointer.y);
        const r = normRect(it.startWorld, end);
        // A plain click on empty canvas already cleared the selection on
        // pointerdown; a real drag selects everything intersecting — ink
        // included (the only way to select strokes).
        if (r.w * camera.scale > DRAG_THRESHOLD || r.h * camera.scale > DRAG_THRESHOLD) {
          const hits = elementsInRect(board.elements, r).map((el) => el.id);
          if (hits.length > 0) setSelectedIds(hits);
        }
        return;
      }

      case "lasso": {
        setLassoPts(null);
        if (!pointer) return;
        const end = toWorld(pointer.x, pointer.y);
        const poly = movedRef.current > DRAG_THRESHOLD ? [...it.points, end] : it.points;
        const hits = elementsInLasso(board.elements, poly).map((el) => el.id);
        if (hits.length > 0) setSelectedIds(hits);
        return;
      }

      case "pointShape": {
        if (movedRef.current > DRAG_THRESHOLD && pointer) {
          // Dragged → move the whole originating selection to the exact final
          // offset (the throttled writes may have skipped the last stretch).
          const end = toWorld(pointer.x, pointer.y);
          const dx = end.x - it.startWorld.x;
          const dy = end.y - it.startWorld.y;
          for (const o of it.orig) updateEl(o.id, { x: o.x + dx, y: o.y + dy });
          trRef.current?.forceUpdate();
          return;
        }
        // Released without moving → click. Pressing an element that was part
        // of a multi-selection collapses to just it (with deep-select cycle);
        // a fresh press already selected it on pointerdown; a press on the
        // selection-box background (id null) keeps the selection.
        if (it.wasInSelection && it.id) handleSelect(it.id);
        return;
      }

      case "ink": {
        setDraftInk(null);
        let pts = inkPtsRef.current;
        inkPtsRef.current = null;
        if (!pts) return;
        // A click with no travel commits as a single round dot (Excalidraw).
        if (movedRef.current <= DRAG_THRESHOLD && pts.length === 2) {
          const cx = pts[0] as number;
          const cy = pts[1] as number;
          pts = [cx - 0.5, cy, cx + 0.5, cy];
        }
        if (pts.length >= 4) {
          const defaults = toolDefaults[it.mode];
          const el = addInkEl(it.mode, pts);
          if (el) updateEl(el.id, { stroke: defaults.stroke, strokeWidth: defaults.strokeWidth });
        }
        return;
      }

      case "create": {
        setDraft(null);
        if (!pointer) return;
        const end = toWorld(pointer.x, pointer.y);
        const start = it.startWorld;

        if (movedRef.current <= DRAG_THRESHOLD) {
          // Click rule (Figma layering): creation tools never select — text
          // and sticky place over anything; shape/line/arrow revert to Select.
          if (it.tool === "text") placeWithEditor("text", end.x, end.y - 16);
          else if (it.tool === "sticky") placeWithEditor("sticky", end.x - 95, end.y - 85);
          else {
            setSelectedIds([]);
            setTool("select");
          }
          return;
        }

        // Drag commit → create, select, and hand over to Select so the resize
        // handles are immediately live ("done with an element → select").
        if (it.tool === "line" || it.tool === "arrow") {
          const el = addLineEl(it.tool, start.x, start.y, end.x, end.y);
          if (el) {
            updateEl(el.id, { stroke: toolDefaults.line.stroke, strokeWidth: toolDefaults.line.strokeWidth });
            setSelectedIds([el.id]);
          }
          setTool("select");
          return;
        }

        const r = normRect(start, end);
        const kind: "rect" | "ellipse" | "sticky" | "text" =
          it.tool === "shape" ? shapeVariant : it.tool;
        const el = addEl(kind, r.x, r.y, { w: r.w, h: r.h });
        if (kind === "rect" || kind === "ellipse") {
          updateEl(el.id, {
            fill: toolDefaults.shape.fill,
            stroke: toolDefaults.shape.stroke,
            strokeWidth: toolDefaults.shape.strokeWidth,
          });
        } else if (kind === "text") {
          updateEl(el.id, { fill: toolDefaults.text.fill });
        }
        setSelectedIds([el.id]);
        if (el.kind === "sticky" || el.kind === "text") {
          setEditing({ id: el.id, value: el.text });
        }
        setTool("select");
        return;
      }
    }
  };
  useEffect(() => {
    const onUp = () => finishRef.current();
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, []);

  const placeWithEditor = (kind: "sticky" | "text", x: number, y: number, size?: { w: number; h: number }) => {
    const el = addEl(kind, x, y, size);
    setSelectedIds([el.id]);
    setEditing({ id: el.id, value: el.kind === "sticky" || el.kind === "text" ? el.text : "" });
    setTool("select");
  };

  // Double-click on empty canvas (Select mode) drops a sticky with its editor.
  const handleDblClick = (e: KonvaEventObject<MouseEvent>) => {
    if (readOnly || present || tool !== "select" || e.target.name() !== "pan") return;
    const pointer = stageRef.current?.getPointerPosition();
    if (!pointer) return;
    const world = toWorld(pointer.x, pointer.y);
    placeWithEditor("sticky", world.x - 95, world.y - 85);
  };

  const openEditor = (id: string) => {
    const el = board.elements.find((e2) => e2.id === id);
    if (!el || (el.kind !== "text" && el.kind !== "sticky")) return;
    setSelectedIds([id]);
    setEditing({ id, value: el.text });
  };
  onEditRef.current = openEditor;

  // Right-click → context menu on elements.
  const handleContextMenu = (e: KonvaEventObject<PointerEvent>) => {
    e.evt.preventDefault();
    if (readOnly || present) return;
    let node: Konva.Node | null = e.target;
    while (node && node.name() !== "element") node = node.getParent();
    if (!node) {
      setCtxMenu(null);
      return;
    }
    const id = node.id();
    setSelectedIds([id]);
    setCtxMenu({ x: e.evt.clientX, y: e.evt.clientY, id });
  };

  const toolbarTools: { id: Tool; label: string; icon: React.ReactNode }[] = [
    {
      id: "select",
      label: `Select — V (${selectMode === "lasso" ? "Lasso" : "Rectangle select"})`,
      icon: <path d={CURSOR_ARROW} fill="currentColor" />,
    },
    {
      id: "pen", label: "Pen — P", icon: (
        <path d="M2 14l1-3.5L11.5 2 14 4.5 5.5 13 2 14z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      ),
    },
    {
      id: "highlighter", label: "Highlighter — H", icon: (
        <>
          <path d="M5 10l5-6.5L13 6 8 12H5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M3 14.5h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </>
      ),
    },
    {
      id: "shape", label: `Shape — R (${shapeVariant === "ellipse" ? "Ellipse" : "Rectangle"}) / O`, icon:
        shapeVariant === "ellipse" ? (
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        ) : (
          <rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        ),
    },
    {
      id: "line", label: "Line — L", icon: (
        <path d="M2.5 13.5L13.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      ),
    },
    {
      id: "arrow", label: "Arrow — A", icon: (
        <>
          <path d="M2.5 13.5L12 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M7.5 3.5H12.5V8.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ),
    },
    {
      id: "text", label: "Text — T", icon: (
        <path d="M3 3h10M8 3v10M5.5 13h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      ),
    },
    {
      id: "sticky", label: "Sticky note — S", icon: (
        <>
          <path d="M2 2h12v8l-4 4H2z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M14 10h-4v4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        </>
      ),
    },
  ];

  /** Sub-popup options per tool (tldraw flyouts). */
  const toolFlyoutOptions: Partial<Record<Tool, { key: string; label: string; active: boolean; pick: () => void }[]>> = {
    select: [
      {
        key: "marquee",
        label: "Rectangle select",
        active: selectMode === "marquee",
        pick: () => {
          setSelectMode("marquee");
          setFlyout(null);
        },
      },
      {
        key: "lasso",
        label: "Lasso select",
        active: selectMode === "lasso",
        pick: () => {
          setSelectMode("lasso");
          setFlyout(null);
        },
      },
    ],
    shape: [
      {
        key: "rect",
        label: "Rectangle",
        active: shapeVariant === "rect",
        pick: () => {
          setShapeVariant("rect");
          setFlyout(null);
        },
      },
      {
        key: "ellipse",
        label: "Ellipse",
        active: shapeVariant === "ellipse",
        pick: () => {
          setShapeVariant("ellipse");
          setFlyout(null);
        },
      },
    ],
  };

  return (
    <div
      className={`board-root ${present ? "presenting" : ""}`}
      style={{
        // The dot grid is part of the canvas — it must move and scale with the
        // camera, not sit static behind it.
        backgroundSize: `${26 * camera.scale}px ${26 * camera.scale}px`,
        backgroundPosition: `${camera.x}px ${camera.y}px`,
      }}
    >
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand">
            <span className="brand-mark">C</span>
            <span className="brand-name">Comata</span>
          </div>
          <span className="topbar-doc">{title ?? "Untitled board"}</span>
        </div>

        <div className="topbar-center">
          {selectedIds.length > 1 ? (
            <div className="props-bar">
              <span className="props-kind">{selectedIds.length} selected</span>
              <button className="prop-action" onClick={deleteSelected}>
                ✕ Delete
              </button>
              <span className="props-hint">⌘D duplicate · ⌫ delete</span>
            </div>
          ) : (
            <PropertiesBar
              selectedEl={selectedEl}
              tool={tool}
              shapeVariant={shapeVariant}
              toolDefaults={toolDefaults}
              setToolDefaults={setToolDefaults}
              updateEl={updateEl}
              onEditText={() => selectedEl && openEditor(selectedEl.id)}
            />
          )}
        </div>

        <div className="topbar-right">
          <div className="avatars" title="People on this board — click to follow someone">
            <span className="avatar" style={{ background: identity.color }}>
              {identity.name.slice(0, 1)}
            </span>
            {board.peers.map((peer) => (
              <button
                key={peer.connectionId}
                className={`avatar avatar-btn ${followConn === peer.connectionId ? "following" : ""}`}
                style={{ background: peer.color }}
                title={`Follow ${peer.name}`}
                onClick={() => setFollowConn(followConn === peer.connectionId ? null : peer.connectionId)}
              >
                {peer.name.slice(0, 1)}
              </button>
            ))}
          </div>

          {kind === "presentation" && (
            <button
              className="present-btn"
              disabled={readOnly || frames.length === 0}
              title={frames.length === 0 ? "Slides arrive in a later update" : "Present — camera jumps between slides"}
              onClick={enterPresent}
            >
              ▶ Present
            </button>
          )}

          <div className="zoom-group" role="group" aria-label="Zoom controls">
            <button title="Zoom out" onClick={() => zoomAtCenter(Math.max(MIN_SCALE, camera.scale / 1.25))}>
              −
            </button>
            <button className="zoom-value" title="Reset zoom to 100%" onClick={() => zoomAtCenter(1)}>
              {Math.round(camera.scale * 100)}%
            </button>
            <button title="Zoom in" onClick={() => zoomAtCenter(Math.min(MAX_SCALE, camera.scale * 1.25))}>
              +
            </button>
          </div>

          <button
            className="info-btn"
            title="Board help"
            aria-label="Board help"
            onClick={() => setShowInfo((v) => !v)}
          >
            i
          </button>
        </div>
      </header>

      {/* Tool dock — left edge, vertical; active tools with variants open a
          sub-popup (tldraw flyout): click the active tool again. */}
      <div className="tool-dock" role="toolbar" aria-label="Board tools">
        {toolbarTools.map((t) => (
          <div key={t.id} className="tool-anchor">
            <button
              className={`tool-btn ${tool === t.id ? "active" : ""}`}
              title={t.label}
              aria-label={t.label}
              disabled={readOnly}
              onClick={() => (tool === t.id && toolFlyoutOptions[t.id] ? setFlyout(flyout === t.id ? null : t.id) : switchTool(t.id))}
            >
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                {t.icon}
              </svg>
              {toolFlyoutOptions[t.id] && <span className="flyout-dot" />}
            </button>
            {flyout === t.id && toolFlyoutOptions[t.id] && (
              <div className="tool-flyout" role="menu">
                {toolFlyoutOptions[t.id]!.map((opt) => (
                  <button key={opt.key} className={opt.active ? "active" : ""} role="menuitem" onClick={opt.pick}>
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div
        className={`board-canvas ${tool !== "select" ? `tool-${tool}` : ""}`}
        style={{ cursor: panning ? "grabbing" : spaceHeld ? "grab" : undefined }}
      >
        <Stage
          ref={stageRef}
          width={size.w}
          height={size.h}
          onWheel={handleWheel}
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onDblClick={handleDblClick}
          onContextMenu={handleContextMenu}
        >
          <Layer>
            <Rect
              name="pan"
              x={0}
              y={0}
              width={size.w}
              height={size.h}
              fill="rgba(0,0,0,0)"
            />
          </Layer>
          <Layer listening={tool === "select" && !present}>
            <Group x={camera.x} y={camera.y} scaleX={camera.scale} scaleY={camera.scale}>
              {board.elements.map((el) => (
                <ElementView
                  key={el.id}
                  el={el}
                  interactive={tool === "select" && !readOnly && !present}
                  selected={selectedIds.includes(el.id)}
                  editingId={editing?.id ?? null}
                  onTransform={onTransformCb}
                  onEdit={onEditCb}
                />
              ))}

              {draftInk &&
                (() => {
                  const v =
                    interactionRef.current.kind === "ink" && interactionRef.current.mode === "highlighter"
                      ? { stroke: "#f5b83d", strokeWidth: 14, opacity: 0.35 }
                      : { stroke: "#e7eaf0", strokeWidth: 2.5, opacity: 1 };
                  return (
                    <Path
                      data={smoothInkPath(draftInk)}
                      stroke={v.stroke}
                      strokeWidth={v.strokeWidth}
                      opacity={v.opacity}
                      lineCap="round"
                      lineJoin="round"
                      fillEnabled={false}
                      listening={false}
                    />
                  );
                })()}
              {draft &&
                (() => {
                  const r = normRect(draft.start, draft.current);
                  if (draft.tool === "line" || draft.tool === "arrow") {
                    return (
                      <Line
                        points={[draft.start.x, draft.start.y, draft.current.x, draft.current.y]}
                        stroke="#e7eaf0"
                        strokeWidth={2}
                        lineCap="round"
                        dash={[6, 5]}
                        listening={false}
                      />
                    );
                  }
                  if (draft.tool === "shape" && shapeVariant === "ellipse") {
                    return (
                      <Ellipse
                        x={r.x + r.w / 2}
                        y={r.y + r.h / 2}
                        radiusX={r.w / 2}
                        radiusY={r.h / 2}
                        stroke="#6c8cff"
                        strokeWidth={1.5}
                        dash={[6, 5]}
                        listening={false}
                      />
                    );
                  }
                  if (draft.tool === "shape" || draft.tool === "sticky" || draft.tool === "text") {
                    return (
                      <Rect
                        x={r.x}
                        y={r.y}
                        width={r.w}
                        height={r.h}
                        stroke="#6c8cff"
                        strokeWidth={1.5}
                        dash={[6, 5]}
                        cornerRadius={6}
                        listening={false}
                      />
                    );
                  }
                  return null;
                })()}
              {lassoPts && lassoPts.length > 1 && (
                <Line
                  points={lassoPts.flatMap((p) => [p.x, p.y])}
                  stroke="#6c8cff"
                  strokeWidth={1.5}
                  lineCap="round"
                  lineJoin="round"
                  dash={[4, 3]}
                  listening={false}
                />
              )}
              {marqueeRect && (
                <Rect
                  x={marqueeRect.x}
                  y={marqueeRect.y}
                  width={marqueeRect.w}
                  height={marqueeRect.h}
                  fill="rgba(108,140,255,0.08)"
                  stroke="#6c8cff"
                  strokeWidth={1}
                  strokeScaleEnabled={false}
                  dash={[4, 3]}
                  listening={false}
                />
              )}
            </Group>
          </Layer>

          {/* Selection layer — always interactive so resize/rotate handles are
              live the moment an element is committed, whatever tool is active. */}
          <Layer listening={!readOnly && !present}>
            <Transformer
              ref={trRef}
              rotateEnabled
              keepRatio={false}
              anchorSize={9}
              anchorCornerRadius={2}
              anchorFill="#ffffff"
              anchorStroke="#6c8cff"
              borderStroke="#6c8cff"
              boundBoxFunc={(oldBox, newBox) =>
                newBox.width < 8 || newBox.height < 8 ? oldBox : newBox
              }
            />
            {/* Canva-style line/arrow selection: the stroke gets a dashed
                highlight (in ElementView) plus two draggable endpoint handles —
                no rectangular overlay. Dragging a handle reshapes the line.
                This layer is untransformed → screen coords: map world → screen
                and keep handle size constant on screen. */}
            {selectedLineEl && (
              <>
                {(["start", "end"] as const).map((end) => {
                  const wx = end === "start" ? selectedLineEl.x : selectedLineEl.x + selectedLineEl.w;
                  const wy = end === "start" ? selectedLineEl.y : selectedLineEl.y + selectedLineEl.h;
                  const s = toScreen(wx, wy);
                  return (
                    <Circle
                      key={end}
                      name="endpoint-handle"
                      x={s.x}
                      y={s.y}
                      radius={6.5}
                      fill="#ffffff"
                      stroke="#6c8cff"
                      strokeWidth={2}
                      draggable
                      onDragMove={dragLineEndpoint(selectedLineEl, end)}
                      onDragEnd={dragLineEndpoint(selectedLineEl, end)}
                    />
                  );
                })}
              </>
            )}
          </Layer>
          <Layer listening={false}>
            {board.peers.map((peer) => {
              const screen = toScreen(peer.x, peer.y);
              return (
                <Group key={peer.connectionId} x={screen.x} y={screen.y}>
                  <Path data={CURSOR_ARROW} fill={peer.color} stroke="#ffffff" strokeWidth={1.2} />
                  <Label x={14} y={15}>
                    <Tag fill={peer.color} cornerRadius={6} />
                    <Text text={peer.name} fontSize={12} fill="#ffffff" padding={5} />
                  </Label>
                </Group>
              );
            })}
          </Layer>
        </Stage>

        {/* Inline-KaTeX overlay for text elements (DOM above the canvas). */}
        <div className="math-overlay">
          {board.elements
            .filter((el): el is TextShape => el.kind === "text" && hasMath(el.text) && el.id !== editing?.id)
            .map((el) => {
              const s = toScreen(el.x, el.y);
              return (
                <div
                  key={el.id}
                  className="math-text"
                  style={{
                    left: s.x,
                    top: s.y,
                    fontSize: el.fontSize * camera.scale,
                    color: el.fill,
                    fontWeight: el.bold ? 700 : 400,
                    fontStyle: el.italic ? "italic" : "normal",
                    textAlign: el.align,
                  }}
                >
                  {el.text.split(/(\$[^$]+\$)/g).map((part, i) =>
                    part.length > 2 && part.startsWith("$") && part.endsWith("$") ? (
                      <span
                        key={i}
                        dangerouslySetInnerHTML={{
                          __html: katex.renderToString(part.slice(1, -1), { throwOnError: false }),
                        }}
                      />
                    ) : (
                      <span key={i}>{part}</span>
                    ),
                  )}
                </div>
              );
            })}
        </div>

        {/* Text/sticky editor (DOM textarea synced to element screen position).
            The Konva text hides while editing — the textarea is the single source of pixels. */}
        {editing &&
          (() => {
            const el = board.elements.find((e2) => e2.id === editing.id);
            if (!el || (el.kind !== "text" && el.kind !== "sticky")) return null;
            const s = toScreen(el.x, el.y);
            const isText = el.kind === "text";
            return (
              <textarea
                className="text-editor"
                autoFocus
                placeholder={isText ? "Text" : "New note"}
                value={editing.value}
                onChange={(e2) => {
                  setEditing({ id: el.id, value: e2.target.value });
                  updateEl(el.id, { text: e2.target.value });
                }}
                onBlur={() => setEditing(null)}
                onKeyDown={(e2) => {
                  e2.stopPropagation();
                  if (e2.key === "Escape") setEditing(null);
                }}
                style={{
                  left: s.x,
                  top: s.y,
                  width: el.w * camera.scale + 60,
                  height: el.h * camera.scale + 24,
                  fontSize: (isText ? el.fontSize : 15) * camera.scale,
                  color: isText ? el.fill : "#4a3f1f",
                  fontWeight: isText && el.bold ? 700 : 400,
                  fontStyle: isText && el.italic ? "italic" : "normal",
                  textAlign: isText ? el.align : "left",
                }}
              />
            );
          })()}

        {/* Right-click context menu. */}
        {ctxMenu && ctxEl && (
          <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            {(ctxEl.kind === "text" || ctxEl.kind === "sticky") && (
              <button
                onClick={() => {
                  openEditor(ctxEl.id);
                  setCtxMenu(null);
                }}
              >
                ✎ Edit text
              </button>
            )}
            <button
              onClick={() => {
                const nid = duplicateEl(ctxEl.id);
                if (nid) setSelectedIds([nid]);
                setCtxMenu(null);
              }}
            >
              ⧉ Duplicate <span className="ctx-key">⌘D</span>
            </button>
            <button
              onClick={() => {
                moveElForward(ctxEl.id);
                setCtxMenu(null);
              }}
            >
              ↑ Bring forward <span className="ctx-key">]</span>
            </button>
            <button
              onClick={() => {
                moveElBackward(ctxEl.id);
                setCtxMenu(null);
              }}
            >
              ↓ Send backward <span className="ctx-key">[</span>
            </button>
            <button
              onClick={() => {
                bringElToFront(ctxEl.id);
                setCtxMenu(null);
              }}
            >
              ⤒ Bring to front
            </button>
            <button
              onClick={() => {
                sendElToBack(ctxEl.id);
                setCtxMenu(null);
              }}
            >
              ⤓ Send to back
            </button>
            <button
              className="danger"
              onClick={() => {
                deleteEl(ctxEl.id);
                setSelectedIds([]);
                setCtxMenu(null);
              }}
            >
              ✕ Delete <span className="ctx-key">⌫</span>
            </button>
          </div>
        )}

        {/* Present-mode controls. */}
        {present && (
          <div className="present-controls">
            <button onClick={prevFrame} disabled={presentIndex === 0} title="Previous frame (←)">
              ◀
            </button>
            <span className="present-count">
              {presentIndex + 1} / {frames.length}
            </span>
            <button onClick={nextFrame} disabled={presentIndex >= frames.length - 1} title="Next frame (→)">
              ▶
            </button>
            <button className="present-exit" onClick={exitPresent}>
              Exit
            </button>
          </div>
        )}

        {/* Follow/presenter pill. */}
        {!present && (followPeer || presenter) && (
          <div className="follow-pill">
            {followPeer ? (
              <>
                <span className="pill-dot" style={{ background: followPeer.color }} />
                Following {followPeer.name}
                <button onClick={() => setFollowConn(null)}>✕ stop</button>
              </>
            ) : (
              presenter && (
                <>
                  <span className="pill-dot" style={{ background: presenter.color }} />
                  {presenter.name} is presenting
                  <button
                    onClick={() =>
                      setFollowConn(followConn === presenter.connectionId ? null : presenter.connectionId)
                    }
                  >
                    Follow
                  </button>
                </>
              )
            )}
          </div>
        )}
      </div>

      {/* (i) help popover — gestures, shortcuts, connection status. */}
      {showInfo && (
        <div className="info-popover">
          <div className="info-conn">
            <span className={`pill ${STATUS_CLASS[board.status]}`}>
              <span className="pill-dot" />
              {STATUS_LABEL[board.status]}
            </span>
          </div>
          <h4>Gestures</h4>
          <p>two-finger scroll = pan · pinch = zoom · drag canvas = rectangle select · double-click canvas = sticky</p>
          <h4>Tool shortcuts</h4>
          <p>
            V select · P pen · H highlighter · R rect · O ellipse · L line · A arrow · T text · S
            sticky
          </p>
          <h4>Selection</h4>
          <p>⌘D duplicate · ⌫ delete · ] forward / [ backward · right-click for more · Esc deselect</p>
          <h4>Ink strokes</h4>
          <p>Strokes ignore clicks — select them by dragging a rectangle around them.</p>
          {kind === "presentation" && (
            <>
              <h4>Present</h4>
              <p>▶ Present flips between frames — ← / → navigate, Esc exits. Others can follow you live.</p>
            </>
          )}
        </div>
      )}

      {board.status === "connecting" && (
        <div className="board-loading">
          <div className="spinner" />
          <span>Connecting to the room…</span>
        </div>
      )}
    </div>
  );
}
