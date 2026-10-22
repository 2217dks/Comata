import { useEffect, useRef, useState } from "react";
import type Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";
import { Group, Label, Layer, Path, Rect, Stage, Tag, Text } from "react-konva";
import type { BoardElement } from "@comata/elements";
import type { Identity } from "../lib/identity";
import type { BoardApi, ConnStatus } from "./useBoard";

type Camera = { x: number; y: number; scale: number };
type Tool = "select" | "rect" | "sticky";

const CURSOR_ARROW = "M0 0 L0 17 L4.6 12.8 L7.4 19.6 L10.2 18.4 L7.4 11.8 L13 11.8 Z";

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;

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

function useWindowSize(): { w: number; h: number } {
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

type ElementViewProps = {
  el: BoardElement;
  readOnly: boolean;
  onMove: (id: string, x: number, y: number) => void;
  onBringToFront: (id: string) => void;
};

function ElementView({ el, readOnly, onMove, onBringToFront }: ElementViewProps) {
  const commitMove = (e: KonvaEventObject<DragEvent>) => {
    onMove(el.id, e.target.x(), e.target.y());
  };

  if (el.kind === "sticky") {
    return (
      <Group
        x={el.x}
        y={el.y}
        rotation={el.rotation}
        draggable={!readOnly}
        onMouseDown={() => {
          if (!readOnly) onBringToFront(el.id);
        }}
        onDragEnd={commitMove}
      >
        <Rect
          width={el.w}
          height={el.h}
          fill={el.fill}
          cornerRadius={8}
          shadowColor="rgba(0,0,0,0.35)"
          shadowBlur={10}
          shadowOffsetY={3}
        />
        <Text
          text={el.text}
          width={el.w}
          height={el.h}
          padding={12}
          fontSize={15}
          fill="#4a3f1f"
          align="left"
          verticalAlign="top"
        />
      </Group>
    );
  }

  return (
    <Rect
      x={el.x}
      y={el.y}
      width={el.w}
      height={el.h}
      rotation={el.rotation}
      fill={el.fill}
      cornerRadius={6}
      stroke="rgba(255,255,255,0.25)"
      strokeWidth={1}
      draggable={!readOnly}
      onMouseDown={() => {
        if (!readOnly) onBringToFront(el.id);
      }}
      onDragEnd={commitMove}
    />
  );
}

export function Board({
  board,
  identity,
  title,
  readOnly = false,
}: {
  board: BoardApi;
  identity: Identity;
  title?: string;
  readOnly?: boolean;
}) {
  const stageRef = useRef<Konva.Stage | null>(null);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 });
  const [tool, setTool] = useState<Tool>("select");
  const size = useWindowSize();

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

  // Tool shortcuts (Figma-style): V select · R rectangle · S sticky · Esc select.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.key === "Escape" || e.key === "v" || e.key === "V") setTool("select");
      else if (e.key === "r" || e.key === "R") setTool("rect");
      else if (e.key === "s" || e.key === "S") setTool("sticky");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleWheel = (e: KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
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
    const cx = size.w / 2;
    const cy = size.h / 2;
    const world = toWorld(cx, cy);
    setCamera({ scale, x: cx - world.x * scale, y: cy - world.y * scale });
  };

  const handleMouseMove = () => {
    const pointer = stageRef.current?.getPointerPosition();
    if (!pointer) return;
    const world = toWorld(pointer.x, pointer.y);
    board.setCursor(world.x, world.y);
  };

  const lastPanPos = useRef<{ x: number; y: number } | null>(null);

  const handlePanStart = () => {
    const pointer = stageRef.current?.getPointerPosition();
    lastPanPos.current = pointer ? { x: pointer.x, y: pointer.y } : null;
  };

  const handlePan = () => {
    const pointer = stageRef.current?.getPointerPosition();
    if (!pointer || !lastPanPos.current) return;
    const dx = pointer.x - lastPanPos.current.x;
    const dy = pointer.y - lastPanPos.current.y;
    lastPanPos.current = { x: pointer.x, y: pointer.y };
    setCamera((c) => ({ ...c, x: c.x + dx, y: c.y + dy }));
  };

  // Click-to-place with the rect/sticky tools (targets the pan surface only).
  const handleStageClick = (e: KonvaEventObject<MouseEvent>) => {
    if (readOnly || e.evt.button !== 0 || e.target.name() !== "pan") return;
    if (tool === "select") return;
    const pointer = stageRef.current?.getPointerPosition();
    if (!pointer) return;
    const world = toWorld(pointer.x, pointer.y);
    if (tool === "rect") board.addRectAt(world.x - 80, world.y - 50);
    else board.addStickyAt(world.x - 95, world.y - 85);
  };

  // Double-click always drops a sticky, regardless of tool.
  const handleDblClick = (e: KonvaEventObject<MouseEvent>) => {
    if (readOnly || e.target.name() !== "pan") return;
    const pointer = stageRef.current?.getPointerPosition();
    if (!pointer) return;
    const world = toWorld(pointer.x, pointer.y);
    board.addStickyAt(world.x - 95, world.y - 85);
  };

  return (
    <div className="board-root">
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand">
            <span className="brand-mark">C</span>
            <span className="brand-name">Comata</span>
          </div>
          <span className="topbar-doc">{title ?? "Untitled board"}</span>
        </div>

        <div className="topbar-center">
          <div className="tool-group" role="toolbar" aria-label="Board tools">
            <button
              className={`tool-btn ${tool === "select" ? "active" : ""}`}
              title="Select — V"
              aria-label="Select tool"
              disabled={readOnly}
              onClick={() => setTool("select")}
            >
              <svg viewBox="0 0 14 20" width="13" height="17" aria-hidden="true">
                <path d={CURSOR_ARROW} fill="currentColor" />
              </svg>
            </button>
            <button
              className={`tool-btn ${tool === "rect" ? "active" : ""}`}
              title="Rectangle — R"
              aria-label="Rectangle tool"
              disabled={readOnly}
              onClick={() => setTool("rect")}
            >
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
            <button
              className={`tool-btn ${tool === "sticky" ? "active" : ""}`}
              title="Sticky note — S"
              aria-label="Sticky note tool"
              disabled={readOnly}
              onClick={() => setTool("sticky")}
            >
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <path d="M2 2h12v8l-4 4H2z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                <path d="M14 10h-4v4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </div>

        <div className="topbar-right">
          <div className="avatars" title="People on this board">
            <span className="avatar" style={{ background: identity.color }}>
              {identity.name.replace("Guest ", "").slice(0, 1)}
            </span>
            {board.peers.map((peer) => (
              <span key={peer.connectionId} className="avatar" style={{ background: peer.color }} title={peer.name}>
                {peer.name.replace("Guest ", "").slice(0, 1)}
              </span>
            ))}
          </div>

          <span className={`pill ${STATUS_CLASS[board.status]}`}>
            <span className="pill-dot" />
            {STATUS_LABEL[board.status]}
          </span>

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
        </div>
      </header>

      <div className={`board-canvas ${tool !== "select" ? `tool-${tool}` : ""}`}>
        <Stage
          ref={stageRef}
          width={size.w}
          height={size.h}
          onWheel={handleWheel}
          onMouseMove={handleMouseMove}
          onClick={handleStageClick}
          onDblClick={handleDblClick}
        >
          <Layer>
            <Rect
              name="pan"
              x={0}
              y={0}
              width={size.w}
              height={size.h}
              fill="rgba(0,0,0,0)"
              draggable
              dragBoundFunc={() => ({ x: 0, y: 0 })}
              onDragStart={handlePanStart}
              onDragMove={handlePan}
              onDragEnd={handlePan}
            />
          </Layer>
          <Layer>
            <Group x={camera.x} y={camera.y} scaleX={camera.scale} scaleY={camera.scale}>
              {board.elements.map((el) => (
                <ElementView
                  key={el.id}
                  el={el}
                  readOnly={readOnly}
                  onMove={board.moveEl}
                  onBringToFront={board.bringElToFront}
                />
              ))}
            </Group>
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
      </div>

      <div className="board-hint">
        two-finger scroll = pan · pinch = zoom · V / R / S = tools · double-click = sticky
      </div>

      {board.status === "connecting" && (
        <div className="board-loading">
          <div className="spinner" />
          <span>Connecting to the room…</span>
        </div>
      )}
    </div>
  );
}
