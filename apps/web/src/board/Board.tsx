import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";
import { Ellipse, Group, Label, Layer, Line, Path, Rect, Stage, Tag, Text, Transformer, Circle } from "react-konva";
import katex from "katex";
import "katex/dist/katex.min.css";
import type { BoardElement, ElementPatch, TextShape, CodeShape, MathShape, CustomShape } from "@comata/elements";
import { ELEMENT_REGISTRY, elementDefaultsFor, isLightBackground } from "@comata/elements";
import { PAGE_W, PAGE_H, type PageRecord } from "@comata/crdt";
import type { Identity } from "../lib/identity";
import { api } from "../lib/api";
import type { BoardApi, ConnStatus, PeerCamera } from "./useBoard";
import { useRemoteCursors } from "./useBoard";
import { draftStore, useDraftState } from "./draftStore";
import { ElementView, hasMath, smoothInkPath } from "./ElementView";
import { CodeElementEditor } from "./CodeElementEditor";
import { MathElementEditor } from "./MathElementEditor";
import { CustomElementEditor, EditPromptDialog, regenerateCustomElement } from "./CustomElementEditor";
import { AiCreateModal } from "./AiCreatePopup";
import {
  DRAG_THRESHOLD,
  IDLE,
  bboxOf,
  elementAtPoint,
  elementsInLasso,
  elementsInRect,
  hitTestElement,
  normRect,
  type Interaction,
  type Rect as RectShape,
  type Vec,
} from "./interactions";

type LiveRect = { x: number; y: number; w: number; h: number; rotation: number };

type Camera = { x: number; y: number; scale: number };
type Tool = "select" | "pen" | "highlighter" | "shape" | "line" | "arrow" | "text" | "sticky" | "code" | "math" | "custom";
type ShapeVariant = "rect" | "ellipse";
type SelectMode = "marquee" | "lasso";

const CURSOR_ARROW = "M0 0 L0 17 L4.6 12.8 L7.4 19.6 L10.2 18.4 L7.4 11.8 L13 11.8 Z";

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;

const SWATCHES = ["#6c8cff", "#3ecf8e", "#f5b83d", "#ff6b6b", "#e7eaf0"];

/** Stable empty focus request — "enter edit mode, keep the existing cursor
 * position" (toolbar/context-menu entries). A stable identity avoids re-firing
 * the editor's focus effect on unrelated re-renders. */
const EMPTY_FOCUS_REQ = {};

/** Remote peer cursors, in their own subscription: reads the cursor
 * side-channel store (useBoard) so peer mousemoves re-render ONLY this
 * component — the Board tree never re-renders for cursor motion. */
const CursorLayer = memo(function CursorLayer({
  toScreen,
}: {
  toScreen: (x: number, y: number) => { x: number; y: number };
}) {
  const cursors = useRemoteCursors();
  return (
    <>
      {[...cursors.entries()].map(([connectionId, c]) => {
        const screen = toScreen(c.x, c.y);
        return (
          <Group key={connectionId} x={screen.x} y={screen.y}>
            <Path data={CURSOR_ARROW} fill={c.color} stroke="#ffffff" strokeWidth={1.2} />
            <Label x={14} y={15}>
              <Tag fill={c.color} cornerRadius={6} />
              <Text text={c.name} fontSize={12} fill="#ffffff" padding={5} />
            </Label>
          </Group>
        );
      })}
    </>
  );
});

/** In-progress gesture previews (marquee/lasso/shape draft/ink stroke),
 * subscribed to the draft store — a drag re-renders ONLY this component.
 * Ink previews with the CURRENT tool defaults (the properties bar edits
 * these live), so the in-flight stroke matches what gets committed. */
const DraftLayer = memo(function DraftLayer({
  camera,
  toolDefaults,
  shapeVariant,
}: {
  camera: { x: number; y: number; scale: number };
  toolDefaults: ToolDefaults;
  shapeVariant: "rect" | "ellipse";
}) {
  const { marquee, lasso, ink, shape, inkMode } = useDraftState();
  const world = { x: camera.x, y: camera.y, scaleX: camera.scale, scaleY: camera.scale };
  return (
    <>
      {ink && (
        (() => {
          // The in-flight mode was captured at stroke start (draft store) —
          // the preview matches what gets committed on pointerup.
          const mode = inkMode;
          const d = toolDefaults[mode];
          return (
            <Group {...world}>
              <Path
                data={smoothInkPath(ink)}
                stroke={d.stroke}
                strokeWidth={d.strokeWidth}
                opacity={mode === "highlighter" ? 0.35 : 1}
                lineCap="round"
                lineJoin="round"
                fillEnabled={false}
                listening={false}
              />
            </Group>
          );
        })()
      )}
      {shape &&
        (() => {
          const r = normRect(shape.start, shape.current);
          return (
            <Group {...world}>
              {shape.tool === "line" || shape.tool === "arrow" ? (
                <Line
                  points={[shape.start.x, shape.start.y, shape.current.x, shape.current.y]}
                  stroke="#e7eaf0"
                  strokeWidth={2}
                  lineCap="round"
                  dash={[6, 5]}
                  listening={false}
                />
              ) : shape.tool === "shape" && shapeVariant === "ellipse" ? (
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
              ) : shape.tool === "shape" || shape.tool === "sticky" || shape.tool === "text" ? (
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
              ) : null}
            </Group>
          );
        })()}
      {lasso && lasso.length > 1 && (
        <Group {...world}>
          <Line
            points={lasso.flatMap((p) => [p.x, p.y])}
            stroke="#6c8cff"
            strokeWidth={1.5}
            lineCap="round"
            lineJoin="round"
            dash={[4, 3]}
            listening={false}
          />
        </Group>
      )}
      {marquee && (
        <Group {...world}>
          <Rect
            x={marquee.x}
            y={marquee.y}
            width={marquee.w}
            height={marquee.h}
            fill="rgba(108,140,255,0.08)"
            stroke="#6c8cff"
            strokeWidth={1}
            strokeScaleEnabled={false}
            dash={[4, 3]}
            listening={false}
          />
        </Group>
      )}
    </>
  );
});

/** In-memory clipboard for copy/paste (elements validated on paste; each
 * successive paste stacks further down-right, Canva/Figma style). */
let clipboardEls: BoardElement[] = [];

/** One math-bearing text element, KaTeX-rendered. Memoized so the expensive
 * katex.renderToString runs only when THIS element changes — the overlay
 * used to re-render every formula on every Board render (camera tick, remote
 * cursor, any keystroke). */
const MathTextItem = memo(function MathTextItem({
  el,
  sx,
  sy,
  scale,
}: {
  el: TextShape;
  sx: number;
  sy: number;
  scale: number;
}) {
  return (
    <div
      className="math-text"
      style={{
        left: sx,
        top: sy,
        fontSize: el.fontSize * scale,
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
});

/** The whole KaTeX overlay: memoized so a Board re-render that doesn't touch
 * elements/camera/skipId skips the katex work entirely. */
const MathTextOverlay = memo(function MathTextOverlay({
  elements,
  camera,
  skipId,
}: {
  elements: TextShape[];
  camera: { x: number; y: number; scale: number };
  skipId: string | null;
}) {
  return (
    <div className="math-overlay">
      {elements.map((el) =>
        el.id === skipId ? null : (
          <MathTextItem
            key={el.id}
            el={el}
            sx={el.x * camera.scale + camera.x}
            sy={el.y * camera.scale + camera.y}
            scale={camera.scale}
          />
        ),
      )}
    </div>
  );
});

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
  sticky: "Click to place a sticky note",
  math: "Click to place a math block — graph expressions, Desmos-style",
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

/** Tool defaults re-derived for the current surface (Slice 7: light pages get
 * dark ink/text — ADR-0006's luminance rule). Replaces the whole defaults
 * object when the surface tone changes. */
function toolDefaultsFor(bg: string): ToolDefaults {
  const d = elementDefaultsFor(bg);
  return {
    pen: { stroke: d.ink, strokeWidth: 2.5 },
    highlighter: { stroke: "#f5b83d", strokeWidth: 14 },
    shape: { fill: "#6c8cff", stroke: d.shapeStroke, strokeWidth: 0 },
    line: { stroke: d.shapeStroke, strokeWidth: 2 },
    text: { fill: d.text },
  };
}

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
  onEditPrompt,
  onRegenerate,
}: {
  selectedEl: BoardElement | null;
  tool: Tool;
  shapeVariant: ShapeVariant;
  toolDefaults: ToolDefaults;
  setToolDefaults: React.Dispatch<React.SetStateAction<ToolDefaults>>;
  updateEl: (id: string, patch: ElementPatch) => void;
  onEditText: () => void;
  onEditPrompt: () => void;
  onRegenerate: () => void;
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
        {selectedEl.kind === "custom" && (
          <>
            <button
              className="prop-action"
              disabled={selectedEl.status === "generating" || !selectedEl.spec}
              title="Feed the widget back with an instruction (new spec version; old one preserved in your library)"
              onClick={onEditPrompt}
            >
              ✦ Edit prompt
            </button>
            <button
              className="prop-action"
              disabled={selectedEl.status === "generating" || !selectedEl.prompt}
              title="Regenerate from the original prompt"
              onClick={onRegenerate}
            >
              ↻ Regenerate
            </button>
          </>
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

/**
 * Invisible Transformer proxy — one per selected resizable element, living in
 * the INPUT stage (band stages are separate Stages, and Konva cannot attach a
 * Transformer across stages). Konva's Transformer scales THIS node; the
 * gesture is translated into an element patch on transformend only (no CRDT
 * writes mid-gesture — they would compound with the still-applied scale).
 * While the gesture runs, Board mirrors the live rect into `liveRects`, which
 * the band rendering and the DOM code editor both consume.
 */
function TransformerProxy({
  el,
  onGesture,
  onCommit,
  clamp,
}: {
  el: BoardElement;
  onGesture: (id: string, rect: LiveRect | null) => void;
  onCommit: (id: string, patch: ElementPatch) => void;
  /** Deck mode: resize commits clamp into the 1920×1080 page. */
  clamp: boolean;
}) {
  const ref = useRef<Konva.Group | null>(null);
  const baseRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  // Empty Group → Konva would report a 0×0 client rect and the Transformer
  // would collapse. Pin it to the element's edge box (normalized for the
  // signed offsets of lines/arrows).
  useEffect(() => {
    const g = ref.current;
    if (!g) return;
    const x0 = Math.min(0, el.w);
    const y0 = Math.min(0, el.h);
    g.getClientRect = () => ({ x: x0, y: y0, width: Math.abs(el.w), height: Math.abs(el.h) });
  });
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  const onTransformStart = () => {
    baseRef.current = { x: el.x, y: el.y, w: el.w, h: el.h };
  };
  const onTransform = () => {
    const g = ref.current;
    const base = baseRef.current;
    if (!g || !base) return;
    onGesture(el.id, {
      x: g.x(),
      y: g.y(),
      w: Math.max(8, base.w * g.scaleX()),
      h: Math.max(8, base.h * g.scaleY()),
      rotation: g.rotation(),
    });
  };
  const onTransformEnd = () => {
    const g = ref.current;
    const base = baseRef.current;
    baseRef.current = null;
    if (!g || !base) return;
    const sx = g.scaleX();
    const sy = g.scaleY();
    g.scaleX(1);
    g.scaleY(1);
    onGesture(el.id, null); // clear the mirror — resize commits with the
    // CRDT geometry; decks clamp the commit into the page (nothing pokes
    // outside 1920×1080 — the page IS the workspace).
    const w = Math.max(8, Math.round(base.w * sx * 100) / 100);
    const h = Math.max(8, Math.round(base.h * sy * 100) / 100);
    const cx = clamp ? Math.max(0, Math.min(PAGE_W - w, g.x())) : g.x();
    const cy = clamp ? Math.max(0, Math.min(PAGE_H - h, g.y())) : g.y();
    commitRef.current(el.id, {
      x: cx,
      y: cy,
      rotation: g.rotation(),
      w,
      h,
    });
  };

  return (
    <Group
      ref={ref}
      id={el.id}
      x={el.x}
      y={el.y}
      rotation={el.rotation}
      onTransformStart={onTransformStart}
      onTransform={onTransform}
      onTransformEnd={onTransformEnd}
    />
  );
}

// ── Board ────────────────────────────────────────────────────────────────────

export function Board({
  board,
  identity,
  title,
  kind = "canvas",
  background = "dark",
  readOnly = false,
  notebookId,
}: {
  board: BoardApi;
  identity: Identity;
  title?: string;
  kind?: "canvas" | "presentation";
  /** New elements derive default ink/text colors from this (Slice 7). */
  background?: "light" | "dark";
  readOnly?: boolean;
  /** Needed by the code element editor (run calls carry it). */
  notebookId?: string;
}) {
  const stageRef = useRef<Konva.Stage | null>(null);
  const boardRootRef = useRef<HTMLDivElement | null>(null);
  const trRef = useRef<Konva.Transformer | null>(null);
  const [camera, setCamera] = useState({ x: 0, y: 0, scale: 1 });
  const [tool, setTool] = useState<Tool>("select");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  /** Text-edit doc-write debounce (250ms) + latest editing value for the
   * flush callback. */
  const textSaveTimerRef = useRef<number | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  /** The code element in EDIT mode (double-click). Editing is the only state
   * in which the DOM layer raises above the canvas and takes the pointer —
   * otherwise the block behaves like any element: click selects, hold-drag
   * moves, handles resize (all via Konva). */
  const [codeEditingId, setCodeEditingId] = useState<string | null>(null);
  /** Double-click→typing focus signal for the code block: screen point plus a
   * monotonically increasing sequence (a fresh object per request so the
   * editor's effect re-fires even for repeated clicks at the same point). */
  const [codeFocus, setCodeFocus] = useState<{ x?: number; y?: number; n: number } | null>(null);
  /** Live world-space rects of elements being resized — local mirror only
   * (no CRDT writes until the Transformer gesture commits). Keyed by element
   * id; drives both the band rendering override and the DOM code editor. */
  const [liveRects, setLiveRects] = useState<Record<string, LiveRect>>({});
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

  // Live previews (render-only mirrors of the machine state) live in the
  // draft store — gesture pointermoves re-render ONLY the DraftLayer, never
  // the Board (perf audit: draft updates were Board-wide state).
  const inkPtsRef = useRef<number[] | null>(null);
  const moveSentRef = useRef(0); // throttle for machine-driven group moves

  // OS-window move for overlay editors (code/math): dragging the element's
  // title bar moves it — even in edit mode, where the DOM layer sits ABOVE
  // the input stage and the stage's own drag never sees the pointer. The
  // editor calls startWindowMove on a toolbar-background pointerdown; the
  // window-level move/up listeners run the drag and commit through updateEl
  // (same throttled writes as pointShape, one undo step via stopCapturing).
  const windowMoveRef = useRef<{
    id: string;
    lastScreen: Vec; // stage-local px
    orig: { x: number; y: number }; // world geometry at drag start
    dx: number; // accumulated stage-local px since drag start
    dy: number;
    moved: boolean;
  } | null>(null);
  const startWindowMove = useCallback(
    (id: string, e: React.PointerEvent) => {
      const stage = stageRef.current?.container();
      if (!stage) return;
      const el = board.elements.find((e2) => e2.id === id);
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = stage.getBoundingClientRect();
      windowMoveRef.current = {
        id,
        lastScreen: { x: e.clientX - rect.left, y: e.clientY - rect.top },
        orig: { x: el.x, y: el.y },
        dx: 0,
        dy: 0,
        moved: false,
      };
      setSelectedIds([id]);
    },
    [board.elements],
  );

  // Present mode (Slice 7): local playback flag.
  const [present, setPresent] = useState(false);

  const size = useWindowSize();
  const {
    setCameraPresence,
    setPresenting,
    duplicateEl,
    pasteEls,
    undo,
    redo,
    stopCapturing,
    updateEl,
    updateEls,
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
    // Selecting anything else closes a code/math edit session (edit = single-owner).
    const sel = pageElements.find((e2) => e2.id === id);
    if (
      codeEditingId &&
      (!sel ||
        (sel.kind !== "code" && sel.kind !== "math" && sel.kind !== "custom") ||
        sel.id !== codeEditingId)
    ) {
      setCodeEditingId(null);
    }
    const pointer = stageRef.current?.getPointerPosition();
    if (!pointer) {
      setSelectedIds([id]);
      return;
    }
    const world = toWorld(pointer.x, pointer.y);
    const current = selectedIds.length === 1 ? selectedIds[0] : null;
    // Shape-aware hits: lines/arrows answer to their stroke, not their bbox.
    const hits = pageElements.filter(
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

  // ── Pages (Slice 7, ADR-0005) ───────────────────────────────────────────────
  // Presentation notebooks: every element lives on a page (pageId); the board
  // shows one page at a time. `pageElements` is the page-scoped view every
  // interaction path reads — pointer code never knows pages exist.
  const isDeck = kind === "presentation";
  const pages = board.pages;
  const [currentPageId, setCurrentPageId] = useState<string | null>(null);
  // Keep the selection valid as pages flip: a page change clears selection,
  // edit sessions, and context menu (nothing carries across pages).
  useEffect(() => {
    if (!isDeck) return;
    if (currentPageId && pages.some((p) => p.id === currentPageId)) return;
    setCurrentPageId(pages[0]?.id ?? null);
  }, [isDeck, pages, currentPageId]);
  useEffect(() => {
    setSelectedIds([]);
    setEditing(null);
    setCodeEditingId(null);
    setCtxMenu(null);
    cancelInteraction();
  }, [currentPageId]);

  const pageElements = useMemo(
    () => (isDeck ? board.elements.filter((el) => el.pageId === currentPageId) : board.elements),
    [isDeck, board.elements, currentPageId],
  );
  /** Fit-to-viewport camera for deck pages (1920×1080 world). Fit leaves
   * room for the page sidebar (168px gutter) so the slide is never covered.
   * Edit decks may zoom INTO the page (Canva-style) but never pan away from
   * it — zoom stays anchored at the viewport center and clamped so the page
   * still covers the screen; present mode snaps back to the exact fit. */
  const SIDEBAR_GUTTER = 168;
  const deckFit = useMemo(() => {
    const scale = Math.min(
      (size.w - SIDEBAR_GUTTER) / PAGE_W,
      (size.h - 60) / PAGE_H,
    );
    return {
      scale,
      x: SIDEBAR_GUTTER + (size.w - SIDEBAR_GUTTER) / 2 - (PAGE_W / 2) * scale,
      y: size.h / 2 - (PAGE_H / 2) * scale,
    };
  }, [size.w, size.h]);
  // Deck pages open at the fit camera (initial mount + page flips), and
  // present mode snaps back to it. Canvas never touches the camera here.
  useEffect(() => {
    if (isDeck) setCamera(deckFit);
  }, [isDeck, currentPageId, deckFit]);
  /** Surface background for new-element color defaults: the current page's
   * background in decks, the notebook background in canvas mode. */
  const surfaceBg =
    isDeck
      ? pages.find((p) => p.id === currentPageId)?.background ?? "#171b24"
      : background === "light"
        ? "#ffffff"
        : "#171b24";
  // New elements derive default ink/text colors from the surface (page
  // background in decks, notebook background on canvas — ADR-0006).
  useEffect(() => {
    setToolDefaults(toolDefaultsFor(surfaceBg));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfaceBg]);

  /** Math-bearing text elements for the KaTeX overlay (filtered once per
   * doc change, not per render). */
  const mathTexts = useMemo(
    () => pageElements.filter((el): el is TextShape => el.kind === "text" && hasMath(el.text)),
    [pageElements],
  );
  const selectedEl = useMemo(
    () => (selectedIds.length === 1 ? pageElements.find((el) => el.id === selectedIds[0]) ?? null : null),
    [pageElements, selectedIds],
  );

  // Stable callbacks for ElementView (memoized) — latest logic lives in refs.
  const onEditRef = useRef<(id: string) => void>(() => {});
  const onEditCb = useCallback((id: string) => onEditRef.current(id), []);
  const onTransformCb = useCallback((id: string, patch: ElementPatch) => updateEl(id, patch), [updateEl]);
  const presenter = useMemo(() => board.peers.find((p) => p.presenting) ?? null, [board.peers]);
  const ctxEl = useMemo(
    () => (ctxMenu ? pageElements.find((el) => el.id === ctxMenu.id) ?? null : null),
    [pageElements, ctxMenu],
  );
  /** Interaction gate for the generated widget's iframe (double-click to
   * enter, Done/Escape/outside-click to leave) — separate from codeEditingId,
   * which opens the editor session. */
  const [customInteractId, setCustomInteractId] = useState<string | null>(null);
  // The interaction gate lives inside the edit session: any path that closes
  // the session (Esc/deselect/tool switch/delete/present) closes the gate.
  useEffect(() => {
    if (customInteractId && customInteractId !== codeEditingId) setCustomInteractId(null);
  }, [codeEditingId, customInteractId]);

  /**
   * Z-banded rendering (Canva model): every element occupies its true global
   * z slot. Elements arrive z-sorted; DOM-overlay blocks (code, math) split
   * the stack into bands of canvas elements. Each band renders as its own
   * canvas stage and each overlay block as a DOM slot, interleaved in DOM
   * order = exact z order. No slot heuristic — reordering one element can
   * never reshuffle another, and nothing moves when a block enters edit mode.
   */
  const bands = useMemo(() => {
    const out: {
      key: string;
      elements: BoardElement[];
      code: CodeShape | null;
      math: MathShape | null;
      custom: CustomShape | null;
    }[] = [];
    let cur: BoardElement[] = [];
    for (const el of pageElements) {
      if (el.kind === "code" || el.kind === "math" || el.kind === "custom") {
        out.push({
          key: el.id,
          elements: cur,
          code: el.kind === "code" ? el : null,
          math: el.kind === "math" ? el : null,
          custom: el.kind === "custom" ? el : null,
        });
        cur = [];
      } else {
        cur.push(el);
      }
    }
    out.push({ key: "tail", elements: cur, code: null, math: null, custom: null });
    return out.filter((b) => b.code || b.math || b.custom || b.elements.length > 0);
  }, [pageElements]);

  /** The band currently in edit mode — editors stay mounted in their band
   * slot and are LIFTED above the input stage with z-index while editing
   * (no remount: CodeMirror history, math sliders/orbit and iframe state all
   * survive entering and leaving edit mode until the page unloads). */
  const editingBandIdx = useMemo(
    () =>
      codeEditingId
        ? bands.findIndex(
            (b) => b.code?.id === codeEditingId || b.math?.id === codeEditingId || b.custom?.id === codeEditingId,
          )
        : -1,
    [bands, codeEditingId],
  );

  const toWorld = (sx: number, sy: number) => ({
    x: (sx - camera.x) / camera.scale,
    y: (sy - camera.y) / camera.scale,
  });

  /** Decks: an element may never sit outside the page — the page IS the whole
   * workspace. Clamps a moved element's top-left so its bbox stays inside
   * 1920×1080 (canvas mode: identity, no clamp). */
  const clampToPage = (x: number, y: number, id: string): { x: number; y: number } => {
    if (!isDeck) return { x, y };
    const el = pageElements.find((e2) => e2.id === id);
    if (!el) return { x, y };
    const b = bboxOf(el);
    const w = Math.min(b.w, PAGE_W);
    const h = Math.min(b.h, PAGE_H);
    return {
      x: Math.max(0, Math.min(PAGE_W - w, x)),
      y: Math.max(0, Math.min(PAGE_H - h, y)),
    };
  };

  /** Deck create-commit clamp: pull a drag rect fully inside the page. */
  const clampRectToPage = (r: RectShape): RectShape => {
    if (!isDeck) return r;
    const w = Math.min(r.w, PAGE_W);
    const h = Math.min(r.h, PAGE_H);
    return {
      x: Math.max(0, Math.min(PAGE_W - w, r.x)),
      y: Math.max(0, Math.min(PAGE_H - h, r.y)),
      w,
      h,
    };
  };

  /** Deck click-place clamp: an element's top-left stays on the page. */
  const clampPointInPage = (x: number, y: number): { x: number; y: number } => {
    if (!isDeck) return { x, y };
    return {
      x: Math.max(0, Math.min(PAGE_W - 40, x)),
      y: Math.max(0, Math.min(PAGE_H - 40, y)),
    };
  };

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

  // Flush a pending debounced text write when the board unmounts.
  useEffect(
    () => () => {
      const t = textSaveTimerRef.current;
      if (t !== null) window.clearTimeout(t);
      const cur = editingRef.current;
      if (cur) updateEl(cur.id, { text: cur.value });
    },
    [updateEl],
  );

  // Wheel router over DOM-overlay editors (code/math): wheel events over
  // overlay content never reach the Konva stage (React dispatches synthetics
  // along the target's fiber path), and React handlers are passive so they
  // can't preventDefault — leaving pinch free to page-zoom the browser and
  // two-finger scroll dead. This capture-phase listener owns ALL wheel over
  // overlay content: pinch (ctrl/meta) → cursor-anchored canvas zoom, plain
  // two-finger scroll → canvas pan (Figma convention, same as handleWheel).
  // The Konva canvas (.konvajs-content), the math plot, the math sidebar and
  // the code block's scrollable regions own their wheel entirely — the router
  // ignores them at ANY scroll position, so inner scroll (and its momentum)
  // never leaks into a canvas pan, boundary or not.
  useEffect(() => {
    const root = boardRootRef.current;
    if (!root) return;
    const guard = (e: WheelEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.closest(".konvajs-content") ||
          t.closest(".math-plot") ||
          t.closest(".math-sidebar") ||
          t.closest(".code-mirror-host, .code-pane"))
      )
        return;
      // Only content actually over an overlay editor needs us — anything else
      // (page chrome outside the canvas) keeps browser behavior.
      if (!t || !t.closest(".code-editor, .math-editor, .custom-editor")) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setCamera((cam) => {
          const rect = root.getBoundingClientRect();
          const px = e.clientX - rect.left;
          const py = e.clientY - rect.top;
          const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, cam.scale * Math.exp(-dy * 0.01)));
          const wx = (px - cam.x) / cam.scale;
          const wy = (py - cam.y) / cam.scale;
          return { scale, x: px - wx * scale, y: py - wy * scale };
        });
        return;
      }
      e.preventDefault();
      setCamera((cam) => ({ ...cam, x: cam.x - dx, y: cam.y - dy }));
    };
    root.addEventListener("wheel", guard, { capture: true, passive: false });
    return () => root.removeEventListener("wheel", guard, { capture: true });
  }, [setCamera]);
  // Broadcast our camera via presence (debounced) — peers' cursors stay
  // meaningful while panning (no consumer mirrors it; follow mode was cut
  // with the frame model — ADR-0005).
  useEffect(() => {
    const t = window.setTimeout(() => setCameraPresence(camera), 80);
    return () => window.clearTimeout(t);
  }, [camera, setCameraPresence]);

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

  // Keyboard: tool shortcuts, delete/duplicate, Escape, present navigation.
  // Present mode flips the CURRENT page (per-user local playback — ADR-0005).
  const pageIndexOf = (id: string | null) => pages.findIndex((p) => p.id === id);
  const nextFrame = () => {
    const idx = pageIndexOf(currentPageId);
    if (idx >= 0 && idx < pages.length - 1) setCurrentPageId(pages[idx + 1]?.id ?? null);
  };
  const prevFrame = () => {
    const idx = pageIndexOf(currentPageId);
    if (idx > 0) setCurrentPageId(pages[idx - 1]?.id ?? null);
  };

  /** Present mode (Slice 7): per-user local playback. Fullscreen-fit of the
   * current page; geometry locked, interactive elements stay live, ink
   * allowed (the lone editing exception). */
  const exitPresent = () => {
    setPresent(false);
    setPresenting(false);
  };
  const enterPresent = () => {
    if (pages.length === 0) return;
    setSelectedIds([]);
    setEditing(null);
    setCodeEditingId(null);
    setCtxMenu(null);
    setPresent(true);
    setPresenting(true);
  };

  const duplicateSelected = () => {
    if (selectedIds.length === 0) return;
    const nids = selectedIds.map((id) => duplicateEl(id)).filter((n): n is string => n !== null);
    if (nids.length > 0) setSelectedIds(nids);
    stopCapturing();
  };

  const deleteSelected = () => {
    if (selectedIds.length === 0) return;
    for (const id of selectedIds) deleteEl(id);
    setSelectedIds([]);
    setEditing(null);
    setCodeEditingId(null);
    stopCapturing();
  };

  // ── Clipboard (⌘C / ⌘X / ⌘V) ───────────────────────────────────────────────
  const pasteCountRef = useRef(0);

  const copySelected = () => {
    if (selectedIds.length === 0) return;
    clipboardEls = pageElements.filter((el) => selectedIds.includes(el.id));
    pasteCountRef.current = 0;
  };

  const cutSelected = () => {
    if (selectedIds.length === 0) return;
    copySelected();
    deleteSelected();
  };

  const pasteClipboard = () => {
    if (clipboardEls.length === 0) return;
    const step = Math.min(pasteCountRef.current, 50) + 1;
    const pasted = pasteEls(clipboardEls, { x: 16 * step, y: 16 * step }, isDeck ? currentPageId ?? undefined : undefined);
    pasteCountRef.current = step;
    if (pasted.length > 0) setSelectedIds(pasted.map((el) => el.id));
    stopCapturing();
  };

  const cancelInteraction = () => {
    interactionRef.current = IDLE;
    inkPtsRef.current = null;
    setPanning(false);
    draftStore.clearAll();
  };

  const switchTool = (next: Tool, variant?: ShapeVariant) => {
    cancelInteraction();
    setFlyout(null);
    setTool(next);
    if (variant) setShapeVariant(variant);
    // Drawing tools start clean (Excalidraw/tldraw clear the selection).
    if (next !== "select") setSelectedIds([]);
    setCodeEditingId(null);
  };

  // Keyboard handlers live in the render body (they close over fresh state
  // each render) and are mirrored into refs; ONE effect attaches the window
  // listeners and delegates to the refs — no per-render listener churn.
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  const onKeyUpRef = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => onKeyRef.current(e);
    const onKeyUp = (e: KeyboardEvent) => onKeyUpRef.current(e);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  onKeyRef.current = (e: KeyboardEvent) => {
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
        if (codeEditingId) {
          setCodeEditingId(null);
          return;
        }
        if (ctxMenu) setCtxMenu(null);
        else if (showInfo) setShowInfo(false);
        else if (present) exitPresent();
        else if (selectedIds.length > 0) setSelectedIds([]);
        else switchTool("select");
        return;
      }

      // Copy works for viewers too (read-only) — everything else mutates.
      if ((e.metaKey || e.ctrlKey) && (e.key === "c" || e.key === "C")) {
        e.preventDefault();
        copySelected();
        return;
      }

      // Viewers can watch, pan, clear selections — but never mutate. Present
      // page-flip (below) works for everyone: it's a LOCAL view change.
      if (readOnly && !present) return;

      // Present mode: ←/→ flip pages, everything else stays locked.
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

      if (e.key === "]" && selectedIds.length === 1) {
        moveElForward(selectedIds[0] as string);
        return;
      }
      if (e.key === "[" && selectedIds.length === 1) {
        moveElBackward(selectedIds[0] as string);
        return;
      }

      if ((e.metaKey || e.ctrlKey) && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        duplicateSelected();
        return;
      }

      // Undo / redo — per-user history (Canva behavior: your undo never
      // touches other people's edits).
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        undo();
        return;
      }
      if (
        ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "z" || e.key === "Z")) ||
        ((e.metaKey || e.ctrlKey) && (e.key === "y" || e.key === "Y"))
      ) {
        e.preventDefault();
        redo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "x" || e.key === "X")) {
        e.preventDefault();
        cutSelected();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "v" || e.key === "V")) {
        e.preventDefault();
        pasteClipboard();
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
  onKeyUpRef.current = (e: KeyboardEvent) => {
    if (e.code === "Space") {
      spaceRef.current = false;
      setSpaceHeld(false);
    }
  };

  // Attach the Transformer to all selected resizable nodes — with multiple
  // selections Konva draws one combined bounding box that scales them all.
  // Single lines/arrows are excluded: they get Canva-style ENDPOINT handles
  // (no rectangular selection overlay) instead.
  const selectedLineEl =
    selectedEl && (selectedEl.kind === "line" || selectedEl.kind === "arrow") ? selectedEl : null;
  /** Code/math blocks resize (handles) but never rotate — window-like elements. */
  const selectedCodeEl =
    selectedEl && (selectedEl.kind === "code" || selectedEl.kind === "math") ? selectedEl : null;

  const trIds = useMemo(
    () =>
      selectedIds.filter((id) => {
        // The code block in edit mode fills its whole box in the DOM — the
        // Transformer overlay would sit underneath it. Hide handles then.
        // The code/math element in edit mode fills its whole box in the DOM —
        // the Transformer overlay would sit underneath it. Hide handles then.
        if (id === codeEditingId) return false;
        const el = pageElements.find((e2) => e2.id === id);
        if (!el || !ELEMENT_REGISTRY[el.kind].resizable) return false;
        if (selectedIds.length === 1 && (el.kind === "line" || el.kind === "arrow")) return false;
        return true;
      }),
    [selectedIds, pageElements, codeEditingId],
  );
  /** One invisible proxy per Transformer-managed selection (see TransformerProxy). */
  const trProxyNodes = useMemo(
    () =>
      trIds
        .map((id) => pageElements.find((e2) => e2.id === id))
        .filter((e2): e2 is BoardElement => e2 !== undefined),
    [trIds, pageElements],
  );
  const liveCb = useCallback((id: string, rect: LiveRect | null) => {
    setLiveRects((cur) => {
      if (!rect) {
        if (!(id in cur)) return cur;
        const next = { ...cur };
        delete next[id];
        return next;
      }
      return { ...cur, [id]: rect };
    });
  }, []);
  useEffect(() => {
    const tr = trRef.current;
    const stage = stageRef.current;
    if (!tr || !stage) return;
    const nodes = trIds
      .map((id) => stage.findOne<Konva.Node>("#" + id))
      .filter((n): n is Konva.Node => n !== null);
    tr.nodes(nodes);
    tr.getLayer()?.batchDraw();
  }, [trIds, pageElements]);

  // Present camera: fit the active page to the viewport. Present pins the
  // camera to the deck fit (1920×1080); edit mode keeps user zoom/pan.
  useEffect(() => {
    if (!present) return;
    setCamera(deckFit);
  }, [present, deckFit]);

  const zoomAtCenter = (scale: number) => {
    // Decks zoom around the workspace center (right of the sidebar), clamped
    // so the page never under-covers the viewport; the "100%" button snaps
    // back to the fit. Canvas keeps free zoom.
    const cx = isDeck ? SIDEBAR_GUTTER + (size.w - SIDEBAR_GUTTER) / 2 : size.w / 2;
    const cy = size.h / 2;
    const world = toWorld(cx, cy);
    const s = isDeck ? Math.max(deckFit.scale, scale) : scale;
    let x = cx - world.x * s;
    let y = cy - world.y * s;
    if (isDeck) {
      x = Math.min(x, SIDEBAR_GUTTER);
      x = Math.max(x, SIDEBAR_GUTTER + (size.w - SIDEBAR_GUTTER) - PAGE_W * s);
      y = Math.min(y, 0);
      y = Math.max(y, size.h - PAGE_H * s);
    }
    setCamera({ scale: s, x, y });
  };

  const handleWheel = (e: KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    // Decks: pinch zooms INTO the page (Canva-style), anchored at the
    // pointer and clamped so the page always covers the workspace — plain
    // two-finger scroll does nothing (no pan off the slide).
    if (isDeck) {
      if (!(e.evt.ctrlKey || e.evt.metaKey)) return;
      const pointer = stageRef.current?.getPointerPosition();
      if (!pointer) return;
      const scale = Math.min(MAX_SCALE, Math.max(deckFit.scale, camera.scale * Math.exp(-e.evt.deltaY * 0.01)));
      const world = toWorld(pointer.x, pointer.y);
      let x = pointer.x - world.x * scale;
      let y = pointer.y - world.y * scale;
      // Clamp: page edges never come inside the viewport.
      x = Math.min(x, SIDEBAR_GUTTER);
      x = Math.max(x, SIDEBAR_GUTTER + (size.w - SIDEBAR_GUTTER) - PAGE_W * scale);
      y = Math.min(y, 0);
      y = Math.max(y, size.h - PAGE_H * scale);
      setCamera({ scale, x, y });
      return;
    }
    const unit = (e.evt.deltaMode === 1 ? 16 : e.evt.deltaMode === 2 ? 100 : 1) as number;
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
      // Throttled at 30ms like every other drag write (this one fired at raw
      // Konva drag rate — 2-3x the write rate of the rest of the app).
      const now = performance.now();
      if (now - moveSentRef.current < 30 && e.type !== "dragend") return;
      moveSentRef.current = now;
      if (end === "start") {
        updateEl(el.id, { x: p.x, y: p.y, w: el.x + el.w - p.x, h: el.y + el.h - p.y });
      } else {
        updateEl(el.id, { w: p.x - el.x, h: p.y - el.y });
      }
    };

  const handleMouseDown = (e: KonvaEventObject<MouseEvent>) => {
    if (readOnly) return;
    const btn = e.evt.button;
    const pointer = getPointer();
    if (!pointer) return;

    // Present mode: ink is the lone editing exception (annotate-while-
    // presenting — Slice 7). Pen/highlighter strokes commit as shared
    // elements; everything else (select/move/create) stays locked.
    if (present) {
      if (btn === 0 && (tool === "pen" || tool === "highlighter")) {
        const world = toWorld(pointer.x, pointer.y);
        downScreenRef.current = { x: pointer.x, y: pointer.y };
        movedRef.current = 0;
        inkPtsRef.current = [world.x, world.y];
        draftStore.setInk([world.x, world.y], tool);
        interactionRef.current = { kind: "ink", mode: tool };
      }
      return;
    }

    // Middle-drag or space-drag pans from any tool (Excalidraw/tldraw).
    // Decks never pan — the camera is pinned to the page (Slice 7 rework).
    if (btn === 1 || (spaceRef.current && btn === 0)) {
      if (isDeck) return;
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
      // Band stages render pixels only — hit-testing here is manual
      // (z-correct, ink click-immune), with a fallback for already-selected
      // ink strokes (marquee-selected strokes must stay draggable).
      let hit = elementAtPoint(pageElements, world, 6 / camera.scale);
      if (!hit) {
        for (let i = pageElements.length - 1; i >= 0; i--) {
          const el = pageElements[i] as BoardElement;
          if (
            el.kind === "ink" &&
            selectedIds.includes(el.id) &&
            hitTestElement(el, world, 6 / camera.scale)
          ) {
            hit = el;
            break;
          }
        }
      }
      if (hit) {
        const id = hit.id;
        const wasInSelection = selectedIds.includes(id);
        if (!wasInSelection) setSelectedIds([id]);
        const moveIds = wasInSelection ? selectedIds : [id];
        const orig = moveIds
          .map((selId) => pageElements.find((e2) => e2.id === selId))
          .filter((e2): e2 is BoardElement => e2 !== undefined)
          .map((e2) => ({ id: e2.id, x: e2.x, y: e2.y }));
        interactionRef.current = { kind: "pointShape", id, wasInSelection, startWorld: world, orig };
        return;
      }
      {
        // Press inside the current selection's bounding box (the empty gaps
        // BETWEEN selected elements)? That's the selection background: drag
        // moves the whole selection, a bare click keeps it (tldraw behavior).
        const sel = selectedIds
          .map((sid) => pageElements.find((e2) => e2.id === sid))
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
        setCodeEditingId(null);
        if (selectMode === "lasso") {
          interactionRef.current = { kind: "lasso", points: [world] };
          draftStore.setLasso([world]);
        } else {
          interactionRef.current = { kind: "marquee", startWorld: world };
          draftStore.setMarquee({ x: world.x, y: world.y, w: 0, h: 0 });
        }
      }
      return;
    }

    if (tool === "pen" || tool === "highlighter") {
      inkPtsRef.current = [world.x, world.y];
      draftStore.setInk([world.x, world.y], tool);
      interactionRef.current = { kind: "ink", mode: tool };
      return;
    }

    // shape / line / arrow / sticky / text — create-drag or click.
    // Creation tools capture the whole canvas (elements are non-interactive),
    // so creating over other elements always works — Figma layering.
    interactionRef.current = { kind: "create", tool, startWorld: world };
    draftStore.setShape({ tool, start: world, current: world });
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
        draftStore.setMarquee(normRect(it.startWorld, world));
        return;
      }
      case "lasso": {
        const pts = it.points;
        const last = pts[pts.length - 1] as Vec;
        const lastScreen = toScreen(last.x, last.y);
        if (Math.hypot(pointer.x - lastScreen.x, pointer.y - lastScreen.y) < 4) return;
        pts.push(world);
        draftStore.setLasso([...pts]);
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
        updateEls(it.orig.map((o) => ({ id: o.id, patch: clampToPage(o.x + dx, o.y + dy, o.id) })));
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
        draftStore.setInk([...pts]);
        return;
      }
      case "create": {
        draftStore.setShape({ tool: it.tool, start: it.startWorld, current: world });
        return;
      }
    }
  };

  // Commits run on window mouseup — releases outside the stage still finish.
  // Every committed gesture ends with stopCapturing() so the next gesture
  // starts a fresh undo entry (a whole drag = one undo step).
  const commitInteraction = () => {
    const it = interactionRef.current;
    interactionRef.current = IDLE;
    setPanning(false);
    const pointer = getPointer();

    switch (it.kind) {
      case "idle":
      case "pan":
        return;

      case "marquee": {
        draftStore.setMarquee(null);
        if (!pointer) return;
        const end = toWorld(pointer.x, pointer.y);
        const r = normRect(it.startWorld, end);
        // A plain click on empty canvas already cleared the selection on
        // pointerdown; a real drag selects everything intersecting — ink
        // included (the only way to select strokes).
        if (r.w * camera.scale > DRAG_THRESHOLD || r.h * camera.scale > DRAG_THRESHOLD) {
          const hits = elementsInRect(pageElements, r).map((el) => el.id);
          if (hits.length > 0) setSelectedIds(hits);
        }
        return;
      }

      case "lasso": {
        draftStore.setLasso(null);
        if (!pointer) return;
        const end = toWorld(pointer.x, pointer.y);
        const poly = movedRef.current > DRAG_THRESHOLD ? [...it.points, end] : it.points;
        const hits = elementsInLasso(pageElements, poly).map((el) => el.id);
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
          updateEls(it.orig.map((o) => ({ id: o.id, patch: clampToPage(o.x + dx, o.y + dy, o.id) })));
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
        draftStore.setInk(null);
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
          const el = addInkEl(it.mode, pts, isDeck ? currentPageId ?? undefined : undefined);
          if (el) updateEl(el.id, { stroke: defaults.stroke, strokeWidth: defaults.strokeWidth });
        }
        return;
      }

      case "create": {
        draftStore.setShape(null);
        if (!pointer) return;
        const end = toWorld(pointer.x, pointer.y);
        const start = it.startWorld;

        if (movedRef.current <= DRAG_THRESHOLD) {
          // Click rule (Figma layering): creation tools never select — text
          // and sticky place over anything; shape/line/arrow revert to Select.
          if (it.tool === "text") placeWithEditor("text", end.x, end.y - 16);
          else if (it.tool === "sticky") placeWithEditor("sticky", end.x - 95, end.y - 85);
          else if (it.tool === "code") placeCode(end.x, end.y);
          else if (it.tool === "math") placeMath(end.x - 260, end.y - 220);
          else if (it.tool === "custom") openAiCreate(end.x, end.y);
          else {
            setSelectedIds([]);
            setTool("select");
          }
          return;
        }

        // Drag commit → create, select, and hand over to Select so the resize
        // handles are immediately live ("done with an element → select").
        if (it.tool === "line" || it.tool === "arrow") {
          const el = addLineEl(it.tool, start.x, start.y, end.x, end.y, isDeck ? currentPageId ?? undefined : undefined);
          if (el) {
            updateEl(el.id, { stroke: toolDefaults.line.stroke, strokeWidth: toolDefaults.line.strokeWidth });
            setSelectedIds([el.id]);
          }
          setTool("select");
          return;
        }

        const r = normRect(start, end);
        // Decks: clamp the created rect into the page (no drag can start or
        // end outside it visually, but be safe).
        const cr = clampRectToPage(r);
        // Code/math/custom are click-placed only — a drag reverts to Select.
        if (it.tool === "code" || it.tool === "math" || it.tool === "custom") {
          setSelectedIds([]);
          setTool("select");
          return;
        }
        const kind: "rect" | "ellipse" | "sticky" | "text" =
          it.tool === "shape" ? shapeVariant : it.tool;
        const el = addEl(kind, cr.x, cr.y, { pageId: isDeck ? currentPageId ?? undefined : undefined, w: cr.w, h: cr.h });
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
  const finishRef = useRef<() => void>(() => {});
  finishRef.current = () => {
    commitInteraction();
    // OS-window title-bar move: commit the final position from the full
    // accumulated offset (the throttled writes may have skipped the last
    // stretch) and split the undo entry.
    const wm = windowMoveRef.current;
    if (wm) {
      windowMoveRef.current = null;
      if (wm.moved) {
        const p = clampToPage(wm.orig.x + wm.dx / camera.scale, wm.orig.y + wm.dy / camera.scale, wm.id);
        updateEl(wm.id, p);
        trRef.current?.forceUpdate();
      }
      stopCapturing();
    }
  };
  useEffect(() => {
    const onUp = () => finishRef.current();
    window.addEventListener("mouseup", onUp);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  // Title-bar move feed: stage-local px deltas → world deltas (divided by the
  // live camera scale), throttled CRDT writes from the drag-start geometry —
  // the same rhythm as pointShape moves. Window-level so the drag survives
  // leaving the editor's DOM.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const wm = windowMoveRef.current;
      if (!wm) return;
      const stage = stageRef.current?.container();
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const dxs = sx - wm.lastScreen.x;
      const dys = sy - wm.lastScreen.y;
      if (dxs === 0 && dys === 0) return;
      wm.lastScreen = { x: sx, y: sy };
      wm.dx += dxs;
      wm.dy += dys;
      if (!wm.moved) {
        if (Math.hypot(wm.dx, wm.dy) < DRAG_THRESHOLD) return;
        wm.moved = true;
      }
      const now = performance.now();
      if (now - moveSentRef.current < 30) return;
      moveSentRef.current = now;
      const p = clampToPage(wm.orig.x + wm.dx / camera.scale, wm.orig.y + wm.dy / camera.scale, wm.id);
      updateEl(wm.id, p);
      trRef.current?.forceUpdate();
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera.scale, updateEl]);

  const placeWithEditor = (kind: "sticky" | "text", x: number, y: number, size?: { w: number; h: number }) => {
    const p = clampPointInPage(x, y);
    const el = addEl(kind, p.x, p.y, { ...(size ?? {}), pageId: isDeck ? currentPageId ?? undefined : undefined });
    setSelectedIds([el.id]);
    setEditing({ id: el.id, value: el.kind === "sticky" || el.kind === "text" ? el.text : "" });
    setTool("select");
  };

  /** Click-placed code element: place, select, and drop straight into edit
   * mode (same first-run feel as placing a sticky). */
  const placeCode = (x: number, y: number) => {
    const p = clampPointInPage(x, y);
    const el = addEl("code", p.x, p.y, { pageId: isDeck ? currentPageId ?? undefined : undefined });
    setSelectedIds([el.id]);
    setCodeEditingId(el.id);
    setTool("select");
  };

  /** Click-placed math element: centered on the click, straight into edit
   * mode (same as code). */
  const placeMath = (x: number, y: number) => {
    const p = clampPointInPage(x, y);
    const el = addEl("math", p.x, p.y, { pageId: isDeck ? currentPageId ?? undefined : undefined });
    setSelectedIds([el.id]);
    setCodeEditingId(el.id);
    setTool("select");
  };

  // ── AI Create (Slice 5b): dock tool → click → spawn popup → generating ────
  // The popup is screen-space (not tied to the element); spawning creates the
  // custom element in Yjs immediately with status:'generating' so every viewer
  // sees the wavy box, then the local caller fires POST /v1/generate and
  // patches title/description/spec in when it lands (docs/custom-elements.md).
  const [aiCreate, setAiCreate] = useState<{ x: number; y: number } | null>(null);
  const aiCreateAtRef = useRef<{ x: number; y: number } | null>(null);
  aiCreateAtRef.current = aiCreate;
  /** Latest projected elements — async generation callbacks read this instead
   * of the render-time closure (the element list moves under them). */
  const elementsRef = useRef(pageElements);
  elementsRef.current = pageElements;

  /** Click-placed AI Create: remember the spawn point, open the popup. */
  const openAiCreate = (x: number, y: number) => {
    setTool("select");
    setAiCreate({ x, y });
  };

  /** Spawn + generate: element first (wavy box for everyone), API call after. */
  const spawnAndGenerate = async (
    prompt: string,
    libraryId?: string,
    html?: string,
    meta?: { title: string; description: string },
  ) => {
    const at = aiCreateAtRef.current;
    setAiCreate(null);
    if (!at) return;
    const pAt = clampPointInPage(at.x - 130, at.y - 90);
    const el = addEl("custom", pAt.x, pAt.y, { pageId: isDeck ? currentPageId ?? undefined : undefined });
    setSelectedIds([el.id]);
    if (html) {
      // Re-spawn from library: spec already exists — no LLM call.
      updateEl(el.id, {
        status: "ready",
        title: meta?.title ?? "Custom element",
        description: meta?.description ?? "",
        libraryId: libraryId ?? "",
        spec: html,
        specVersion: 1,
      });
      return;
    }
    updateEl(el.id, { status: "generating", prompt, spec: "", specVersion: 0 });
    try {
      const res = await api<{
        title: string;
        description: string;
        html: string;
        libraryId: string;
      }>("/v1/ai/generate", { method: "POST", body: JSON.stringify({ prompt }) });
      // Element may have been deleted mid-generation.
      if (!elementsRef.current.some((e2) => e2.id === el.id)) return;
      updateEl(el.id, {
        status: "ready",
        title: res.title,
        description: res.description,
        spec: res.html,
        specVersion: 1,
        libraryId: res.libraryId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!elementsRef.current.some((e2) => e2.id === el.id)) return;
      updateEl(el.id, { status: "error", errorMessage: message });
    }
  };

  /** Library re-spawn applies the picked entry's spec directly (no LLM call). */

  /** Edit-prompt dialog target (element id) — regenerate with an instruction. */
  const [editPromptFor, setEditPromptFor] = useState<string | null>(null);

  // Double-click opens editors (code/sticky/text) — manual hit-test, band
  // stages carry no Konva targets. No sticky placement here: elements are
  // only created via the dock tools.
  const handleDblClick = (e: KonvaEventObject<MouseEvent>) => {
    if (readOnly || present || tool !== "select") return;
    const pointer = stageRef.current?.getPointerPosition();
    if (!pointer) return;
    const world = toWorld(pointer.x, pointer.y);
    const hit = elementAtPoint(pageElements, world, 6 / camera.scale);
    if (hit && (hit.kind === "code" || hit.kind === "math" || hit.kind === "sticky" || hit.kind === "text")) {
      // Code double-clicks enter typing mode AT the clicked point — the
      // editor consumes {x,y} to place the caret (fix 2: no third click).
      if (hit.kind === "code") {
        setCodeFocus({ x: e.evt.clientX, y: e.evt.clientY, n: (codeFocus?.n ?? 0) + 1 });
      }
      openEditor(hit.id);
      return;
    }
    // Double-click a generated widget → interaction edit mode (its sliders/
    // buttons work for this user; Done/Escape/outside click exits).
    if (hit && hit.kind === "custom" && hit.status === "ready") {
      setSelectedIds([hit.id]);
      setCodeEditingId(hit.id);
      setCustomInteractId(hit.id);
      return;
    }
    // Double-click on empty canvas (or an ink stroke) does nothing.
  };

  const openEditor = (id: string) => {
    const el = pageElements.find((e2) => e2.id === id);
    if (!el) return;
    if (el.kind === "code" || el.kind === "math") {
      setSelectedIds([id]);
      setCodeEditingId(id);
      return;
    }
    if (el.kind !== "text" && el.kind !== "sticky") return;
    setSelectedIds([id]);
    setEditing({ id, value: el.text });
  };
  onEditRef.current = openEditor;

  /** Exit code edit mode (deselect/Escape/tool switch/deleting the element).
   * Windows have no close button — clicking outside the element dismisses. */

  // Right-click → context menu on elements. Band stages are non-interactive,
  // so hit-testing is manual; right-clicks on the DOM code editor forward
  // through the code layer's onContextMenu into this same path.
  const handleContextMenu = (e: KonvaEventObject<PointerEvent>) => {
    e.evt.preventDefault();
    if (readOnly || present) return;
    const pointer = getPointer();
    if (!pointer) return;
    const world = toWorld(pointer.x, pointer.y);
    const hit = elementAtPoint(pageElements, world, 6 / camera.scale);
    if (!hit) {
      setCtxMenu(null);
      return;
    }
    setSelectedIds([hit.id]);
    setCtxMenu({ x: e.evt.clientX, y: e.evt.clientY, id: hit.id });
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
    {
      id: "code", label: "Code — click to place a runnable code file", icon: (
        <>
          <path d="M5.5 4L2 8l3.5 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M10.5 4L14 8l-3.5 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ),
    },
    {
      id: "math", label: "Math — click to place a graphing block (Desmos-style)", icon: (
        <>
          <path d="M1.5 12.5C3.5 12.5 4 3.5 6 3.5S8.5 12.5 10.5 12.5s1.5-6 4-6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="13.5" cy="10" r="1.4" fill="currentColor" stroke="none" />
        </>
      ),
    },
    {
      id: "custom", label: "AI Create — click to generate an interactive widget", icon: (
        <>
          <path d="M8 1.5l1.4 3.9L13.5 6l-3.2 2.4L11.5 12 8 9.8 4.5 12l1.2-3.6L2.5 6l4.1-.6z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          <circle cx="12.8" cy="12.8" r="1.5" fill="currentColor" stroke="none" />
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

  /** One sandwich slot: a band's display stage + (optionally) its code/math
   * block as a camera-space DOM slot. Bands render ONCE each — when a block
   * enters edit mode its band is lifted above the input stage with z-index
   * (`.band-editing`), and bands above it are lifted higher (`.band-above`)
   * so everything keeps its true z. No remount: CodeMirror history, math
   * sliders/orbit and iframe state survive edit-mode enter/exit. */
  const renderBand = (band: (typeof bands)[number]) => {
    // Present mode: interactive elements (code/math/custom) go LIVE for every
    // viewer — no double-click needed (Slice 7). The widget iframe gate also
    // opens. Geometry stays locked (input stage is dead in present).
    const isEditingBand =
      present
        ? Boolean(band.code || band.math || band.custom)
        : band.code?.id === codeEditingId ||
          band.math?.id === codeEditingId ||
          band.custom?.id === codeEditingId;
    const liftClass = present
      ? "band-present"
      : isEditingBand
        ? "band-editing"
        : editingBandIdx >= 0 && bands.indexOf(band) > editingBandIdx
          ? "band-above"
          : "";
    return (
    <Fragment key={band.key}>
      {band.elements.length > 0 && (
        <Stage
          width={size.w}
          height={size.h}
          listening={false}
          className={liftClass}
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        >
          <Layer>
            <Group x={camera.x} y={camera.y} scaleX={camera.scale} scaleY={camera.scale}>
              {band.elements.map((el) => {
                const live = liveRects[el.id];
                const draw = live ? { ...el, x: live.x, y: live.y, w: live.w, h: live.h, rotation: live.rotation } : el;
                return (
                  <ElementView
                    key={el.id}
                    el={draw}
                    selected={selectedIds.includes(el.id)}
                    editing={editing?.id === el.id}
                    onEdit={onEditCb}
                  />
                );
              })}
            </Group>
          </Layer>
        </Stage>
      )}
      {band.code && (() => {
        const el = band.code;
        // During a resize gesture the CRDT geometry is stale — the DOM
        // box mirrors the live Transformer rect until commit.
        const live = liveRects[el.id];
        const geo = live ?? el;
        const style = {
          left: geo.x,
          top: geo.y,
          width: geo.w,
          height: geo.h,
          fontSize: 14 * el.scale,
          transform: live && live.rotation ? `rotate(${live.rotation}deg)` : undefined,
          transformOrigin: "top left",
        };
        return (
          <div
            className={`code-layer ${liftClass}`}
            style={{
              transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`,
            }}
            onContextMenu={(e) => {
              // The DOM editor swallows right-clicks before the input
              // stage sees them — forward into the element context menu.
              const target = (e.target as HTMLElement).closest(".code-editor");
              const id = target?.getAttribute("data-el-id");
              if (!id) return;
              e.preventDefault();
              setSelectedIds([id]);
              setCtxMenu({ x: e.clientX, y: e.clientY, id });
            }}
          >
            <CodeElementEditor
              el={el}
              notebookId={notebookId!}
              canWrite={!readOnly}
              interactive={isEditingBand}
              dataElId={el.id}
              style={style}
              onChange={(patch) => updateEl(el.id, patch)}
              onWindowDragStart={(e) => startWindowMove(el.id, e)}
              focusRequest={isEditingBand ? (codeFocus?.n ? codeFocus : EMPTY_FOCUS_REQ) : undefined}
            />
          </div>
        );
      })()}
      {band.math && (() => {
        const el = band.math;
        const live = liveRects[el.id];
        const geo = live ?? el;
        const style = {
          left: geo.x,
          top: geo.y,
          width: geo.w,
          height: geo.h,
          transform: live && live.rotation ? `rotate(${live.rotation}deg)` : undefined,
          transformOrigin: "top left",
        };
        return (
          <div
            className={`math-layer ${liftClass}`}
            style={{
              transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`,
            }}
            onContextMenu={(e) => {
              const target = (e.target as HTMLElement).closest(".math-editor");
              const id = target?.getAttribute("data-el-id");
              if (!id) return;
              e.preventDefault();
              setSelectedIds([id]);
              setCtxMenu({ x: e.clientX, y: e.clientY, id });
            }}
          >
            <MathElementEditor
              el={el}
              canWrite={!readOnly}
              interactive={isEditingBand}
              dataElId={el.id}
              style={style}
              onChange={(patch) => updateEl(el.id, patch)}
              onWindowDragStart={(e) => startWindowMove(el.id, e)}
            />
          </div>
        );
      })()}
      {band.custom && (() => {
        const el = band.custom;
        const live = liveRects[el.id];
        const geo = live ?? el;
        const style = {
          left: geo.x,
          top: geo.y,
          width: geo.w,
          height: geo.h,
          transform: live && live.rotation ? `rotate(${live.rotation}deg)` : undefined,
          transformOrigin: "top left",
        };
        return (
          <div
            className={`custom-layer ${liftClass}`}
            style={{
              transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`,
            }}
            onContextMenu={(e) => {
              const target = (e.target as HTMLElement).closest(".custom-editor");
              const id = target?.getAttribute("data-el-id");
              if (!id) return;
              e.preventDefault();
              setSelectedIds([id]);
              setCtxMenu({ x: e.clientX, y: e.clientY, id });
            }}
          >
            <CustomElementEditor
              el={el}
              interactive={isEditingBand}
              editing={present || customInteractId === el.id}
              style={style}
              onChange={(patch) => updateEl(el.id, patch)}
              onWindowDragStart={(e) => startWindowMove(el.id, e)}
              onExitEdit={() => setCustomInteractId(null)}
            />
          </div>
        );
      })()}
    </Fragment>
  );
  };

  return (
    <div
      ref={boardRootRef}
      className={`board-root ${present ? "presenting" : ""} ${isDeck ? "deck" : ""}`}
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
              onEditPrompt={() => selectedEl?.kind === "custom" && setEditPromptFor(selectedEl.id)}
              onRegenerate={() => {
                if (selectedEl?.kind !== "custom") return;
                regenerateCustomElement(
                  selectedEl,
                  "",
                  (p) => updateEl(selectedEl.id, p),
                  () => elementsRef.current.some((e2) => e2.id === selectedEl.id),
                );
              }}
            />
          )}
        </div>

        <div className="topbar-right">
          <div className="avatars" title="People on this board">
            <span className="avatar" style={{ background: identity.color }}>
              {identity.name.slice(0, 1)}
            </span>
            {board.peers.map((peer) => (
              <span key={peer.connectionId} className="avatar" style={{ background: peer.color }} title={peer.name}>
                {peer.name.slice(0, 1)}
              </span>
            ))}
          </div>

          {kind === "presentation" && (
            <button
              className="present-btn"
              disabled={readOnly || pages.length === 0}
              title={present ? "Exit presentation" : "Present — fullscreen page playback (local to you)"}
              onClick={() => (present ? exitPresent() : enterPresent())}
            >
              {present ? "✕ Exit" : "▶ Present"}
            </button>
          )}

          {/* Decks zoom into the page (clamped); "100%" snaps back to fit. */}
          <div className="zoom-group" role="group" aria-label="Zoom controls">
            <button title="Zoom out" onClick={() => zoomAtCenter(Math.max(MIN_SCALE, camera.scale / 1.25))}>
              −
            </button>
            <button
              className="zoom-value"
              title={isDeck ? "Reset zoom to fit page" : "Reset zoom to 100%"}
              onClick={() => (isDeck ? setCamera(deckFit) : zoomAtCenter(1))}
            >
              {isDeck ? `${Math.round((camera.scale / deckFit.scale) * 100)}%` : `${Math.round(camera.scale * 100)}%`}
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

      {/* Page sidebar (decks only): thumbnails + page management chrome.
          Present mode hides it; it lives left of the canvas like Canva. */}
      {isDeck && (
        <PageSidebar
          pages={pages}
          currentId={currentPageId}
          readOnly={readOnly}
          isPresent={present}
          onSelect={setCurrentPageId}
          onAdd={() => {
            const id = board.addPage(undefined, surfaceBg);
            if (id) setCurrentPageId(id);
          }}
          onDuplicate={(id) => {
            const nid = board.duplicatePage(id);
            if (nid) setCurrentPageId(nid);
          }}
          onDelete={(id) => {
            board.deletePage(id);
          }}
          onReorder={(from, to) => board.movePage(from, to)}
          onBackground={(id, bg) => board.setPageBackground(id, bg)}
        />
      )}

      <div
        className={`board-canvas ${tool !== "select" ? `tool-${tool}` : ""}`}
        style={{ cursor: panning ? "grabbing" : spaceHeld ? "grab" : undefined }}
      >
        {/* Deck page surface: the 1920×1080 page rect with its background
            color, UNDER every band. It IS the workspace — camera is pinned to
            the fit, so the rect exactly fills the viewport; no dressing. */}
        {isDeck && currentPageId && (
          <div
            className="deck-page-surface"
            style={{
              left: camera.x,
              top: camera.y,
              width: PAGE_W * camera.scale,
              height: PAGE_H * camera.scale,
              background: pages.find((p) => p.id === currentPageId)?.background ?? "#171b24",
            }}
          />
        )}

        {/* Z-banded sandwich (Canva model): bands of canvas elements interleaved
            with code blocks in exact global z order. Each band is a
            non-interactive display stage (pixels only); each code block is a
            camera-space DOM slot. One INPUT stage on top owns all pointer
            events — selection/drag/creation are resolved by manual hit-testing
            (elementAtPoint), never by Konva targets. */}
        {bands.map((band) => renderBand(band))}

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
          {/* Selection layer — always interactive so resize/rotate handles are
              live the moment an element is committed, whatever tool is active.
              The Transformer drives PROXY nodes (one invisible Group per
              selected element) — cross-stage attachment is impossible, so the
              proxies translate Konva's scale gesture into element patches. */}
          <Layer listening={!readOnly && !present}>
            <Group x={camera.x} y={camera.y} scaleX={camera.scale} scaleY={camera.scale}>
              {trProxyNodes.map((el) => (
                <TransformerProxy key={el.id} el={el} clamp={isDeck} onGesture={liveCb} onCommit={onTransformCb} />
              ))}
              <Transformer
                ref={trRef}
                rotateEnabled={!selectedCodeEl}
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
            </Group>
          </Layer>
          {/* Canva-style line/arrow endpoint handles (screen space, untransformed
              layer). Draggable circles that reshape the line live. */}
          <Layer listening={!readOnly && !present}>
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
            <DraftLayer camera={camera} toolDefaults={toolDefaults} shapeVariant={shapeVariant} />
            <CursorLayer toScreen={toScreen} />
          </Layer>
        </Stage>

        {/* Code/math/custom blocks render ONCE in their band slots (renderBand).
            In edit mode the band lifts above this input stage via z-index
            (.band-editing), and bands above it lift higher (.band-above) —
            everyone keeps true z with NO remount, so CodeMirror history, math
            sliders/orbit and iframe state survive entering/leaving edit mode. */}

        {/* Inline-KaTeX overlay for text elements (DOM above the canvas).
            Memoized: katex.renderToString runs per formula only when that
            element (or the camera/text-edit state) changes — not on every
            Board render (remote cursors, keystrokes elsewhere, etc.). */}
        <MathTextOverlay
          elements={mathTexts}
          camera={camera}
          skipId={editing?.id ?? null}
        />


        {/* Text/sticky editor (DOM textarea synced to element screen position).
            The Konva text hides while editing — the textarea is the single source of pixels. */}
        {editing &&
          (() => {
            const el = pageElements.find((e2) => e2.id === editing.id);
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
                  // Debounced CRDT write: the textarea is the instant source
                  // of pixels (editing.value); the doc write — and the Board
                  // render it drags behind it — waits for a typing pause.
                  // Flushed on blur/unmount/Escape so nothing is lost.
                  const t = textSaveTimerRef.current;
                  if (t !== null) window.clearTimeout(t);
                  textSaveTimerRef.current = window.setTimeout(() => {
                    textSaveTimerRef.current = null;
                    const cur = editingRef.current;
                    if (cur) updateEl(cur.id, { text: cur.value });
                  }, 250);
                }}
                onBlur={() => {
                  const t = textSaveTimerRef.current;
                  if (t !== null) {
                    window.clearTimeout(t);
                    textSaveTimerRef.current = null;
                  }
                  const cur = editingRef.current;
                  if (cur) updateEl(cur.id, { text: cur.value });
                  setEditing(null);
                }}
                onKeyDown={(e2) => {
                  e2.stopPropagation();
                  if (e2.key === "Escape") {
                    const t = textSaveTimerRef.current;
                    if (t !== null) {
                      window.clearTimeout(t);
                      textSaveTimerRef.current = null;
                    }
                    const cur = editingRef.current;
                    if (cur) updateEl(cur.id, { text: cur.value });
                    setEditing(null);
                  }
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
        {/* AI Create modal (centered, dimmed canvas; AI Create tool click).
            The click point is already stored — the modal just collects input. */}
        {aiCreate && (
          <AiCreateModal
            onSpawn={(prompt) => spawnAndGenerate(prompt)}
            onSpawnFromLibrary={(entry) =>
              spawnAndGenerate(entry.prompt, entry.id, entry.html, {
                title: entry.title,
                description: entry.description,
              })
            }
            onClose={() => setAiCreate(null)}
          />
        )}

        {/* Edit-prompt dialog: regenerate an existing widget with an instruction. */}
        {editPromptFor && (
          <EditPromptDialog
            onCancel={() => setEditPromptFor(null)}
            onSubmit={(instruction) => {
              const el = pageElements.find(
                (e2): e2 is CustomShape => e2.id === editPromptFor && e2.kind === "custom",
              );
              setEditPromptFor(null);
              if (!el) return;
              regenerateCustomElement(
                el,
                instruction,
                (p) => updateEl(el.id, p),
                () => elementsRef.current.some((e2) => e2.id === el.id),
              );
            }}
          />
        )}

        {ctxMenu && ctxEl && (
          <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            {isDeck && pages.length > 1 && (
              <>
                <div className="ctx-section">Move to page</div>
                {pages.map((p, i) =>
                  p.id === currentPageId ? null : (
                    <button
                      key={p.id}
                      onClick={() => {
                        board.moveElsToPage([ctxEl.id], p.id);
                        setSelectedIds([]);
                        setCtxMenu(null);
                      }}
                    >
                      ➜ {i + 1}
                    </button>
                  ),
                )}
              </>
            )}
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
            {ctxEl.kind === "code" && (
              <button
                onClick={() => {
                  setCodeEditingId(ctxEl.id);
                  setCtxMenu(null);
                }}
              >
                ⌨ Edit code
              </button>
            )}
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

        {/* Present-mode controls: arrows + page counter, that's it. */}
        {present && (
          <div className="present-controls">
            <button onClick={prevFrame} disabled={pageIndexOf(currentPageId) <= 0} title="Previous page (←)">
              ◀
            </button>
            <span className="present-count">
              {pageIndexOf(currentPageId) + 1} / {pages.length}
            </span>
            <button onClick={nextFrame} disabled={pageIndexOf(currentPageId) >= pages.length - 1} title="Next page (→)">
              ▶
            </button>
            <button className="present-exit" onClick={exitPresent}>
              Exit
            </button>
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
          <p>{isDeck ? "Pages fill the screen — no pan/zoom. Drag canvas = rectangle select · double-click canvas = sticky" : "two-finger scroll = pan · pinch = zoom · drag canvas = rectangle select · double-click canvas = sticky"}</p>
          <h4>Tool shortcuts</h4>
          <p>
            V select · P pen · H highlighter · R rect · O ellipse · L line · A arrow · T text · S
            sticky
          </p>
          <h4>Selection</h4>
          <p>
            ⌘D duplicate · ⌘C copy · ⌘X cut · ⌘V paste · ⌫ delete · ] forward / [ backward ·
            right-click for more · Esc deselect
          </p>
          <h4>History</h4>
          <p>⌘Z undo · ⌘⇧Z redo — your undo only reverts your own changes, never your collaborators'.</p>
          <h4>Ink strokes</h4>
          <p>Strokes ignore clicks — select them by dragging a rectangle around them.</p>
          {kind === "presentation" && (
            <>
              <h4>Present</h4>
              <p>▶ Present plays pages fullscreen on YOUR screen (← / → flip, Esc exits). Pen/highlighter still annotate live; code/math widgets stay interactive. Editing (move/resize) is locked.</p>
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

// ── Page sidebar (Slice 7, ADR-0006) ─────────────────────────────────────────
// Edit-mode editor chrome: thumbnails, add/duplicate/delete, drag-reorder,
// per-page background color. Present mode hides it entirely; viewers get the
// pdf-viewer variant (read-only thumbnails) via `readOnly`.

function PageSidebar({
  pages,
  currentId,
  readOnly,
  isPresent,
  onSelect,
  onAdd,
  onDuplicate,
  onDelete,
  onReorder,
  onBackground,
}: {
  pages: PageRecord[];
  currentId: string | null;
  readOnly: boolean;
  isPresent: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onReorder: (from: number, to: number) => void;
  onBackground: (pageId: string, bg: string) => void;
}) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [bgPickerFor, setBgPickerFor] = useState<string | null>(null);

  if (isPresent) return null;

  return (
    <div className={`page-sidebar ${readOnly ? "page-sidebar-ro" : ""}`}>
      {pages.map((p, i) => (
        <div
          key={p.id}
          className={`page-thumb ${p.id === currentId ? "active" : ""} ${dragIdx === i ? "dragging" : ""}`}
          draggable={!readOnly}
          onDragStart={() => setDragIdx(i)}
          onDragOver={(e) => {
            if (dragIdx === null || dragIdx === i) return;
            e.preventDefault();
            onReorder(dragIdx, i);
            setDragIdx(i);
          }}
          onDragEnd={() => setDragIdx(null)}
        >
          <button className="page-thumb-btn" onClick={() => onSelect(p.id)}>
            <span
              className="page-thumb-canvas"
              style={{
                background: p.background,
                color: isLightBackground(p.background) ? "#1a1d24" : "#e7eaf0",
              }}
            >
              {i + 1}
            </span>
          </button>
          <div className="page-thumb-meta">
            <span className="page-num">{i + 1}</span>
            {!readOnly && (
              <>
                <button
                  className="page-thumb-act"
                  title="Duplicate page"
                  onClick={() => onDuplicate(p.id)}
                >
                  ⧉
                </button>
                <button
                  className="page-thumb-act"
                  title={pages.length <= 1 ? "The last page cannot be deleted" : "Delete page"}
                  disabled={pages.length <= 1}
                  onClick={() => onDelete(p.id)}
                >
                  ✕
                </button>
                <button
                  className="page-thumb-act"
                  title="Page background"
                  onClick={() => setBgPickerFor(bgPickerFor === p.id ? null : p.id)}
                >
                  ▨
                </button>
                {bgPickerFor === p.id && (
                  <span className="page-bg-picker">
                    {["#ffffff", "#f4efe6", "#e8f4f8", "#171b24", "#101418", "#1a1626"].map((c) => (
                      <button
                        key={c}
                        className="page-bg-swatch"
                        style={{ background: c }}
                        onClick={() => {
                          onBackground(p.id, c);
                          setBgPickerFor(null);
                        }}
                      />
                    ))}
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      ))}
      {!readOnly && (
        <button className="page-add" onClick={onAdd}>
          + Add page
        </button>
      )}
    </div>
  );
}
