import { memo } from "react";
import type { KonvaEventObject } from "konva/lib/Node";
import { Arrow, Ellipse, Group, Line, Path, Rect, Text } from "react-konva";
import type { BoardElement, ElementPatch, InkShape } from "@comata/elements";

/** True when a text payload carries inline KaTeX segments ($…$). */
export function hasMath(text: string): boolean {
  return /\$[^$]+\$/.test(text);
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Quadratic-midpoint smoothing: the classic technique for ink — control points
 * at the raw samples, curve anchors at segment midpoints. Produces soft,
 * artifact-free curves instead of jagged polylines.
 */
export function smoothInkPath(points: number[]): string {
  const n = points.length;
  if (n < 4) {
    const x = points[0] ?? 0;
    const y = points[1] ?? 0;
    return `M ${r2(x)} ${r2(y)} L ${r2(x + 0.01)} ${r2(y)}`; // single dot
  }
  let d = `M ${r2(points[0] as number)} ${r2(points[1] as number)}`;
  for (let i = 2; i < n - 2; i += 2) {
    const mx = r2(((points[i] as number) + (points[i + 2] as number)) / 2);
    const my = r2(((points[i + 1] as number) + (points[i + 3] as number)) / 2);
    d += ` Q ${r2(points[i] as number)} ${r2(points[i + 1] as number)} ${mx} ${my}`;
  }
  return `${d} L ${r2(points[n - 2] as number)} ${r2(points[n - 1] as number)}`;
}

export type ElementViewProps = {
  el: BoardElement;
  /** Whether the element layer accepts pointer events (Select mode only). */
  interactive: boolean;
  /** Part of the current (possibly multi-element) selection. */
  selected?: boolean;
  /** The element currently being text-edited — its Konva text hides so the
   * DOM textarea is the single source of pixels (no double rendering). */
  editingId: string | null;
  onTransform: (id: string, patch: ElementPatch) => void;
  onEdit: (id: string) => void;
};

/**
 * One Konva Group per element — a pure render + hit-target surface. All
 * movement is handled by the Board's pointer state machine (so dragging a
 * multi-selection moves the whole selection, tldraw-style); the Transformer
 * in Board attaches to the selected group for resize/rotate.
 *
 * Ink strokes are click-immune (rule: strokes are only selectable via
 * rectangle/lasso select).
 *
 * Memoized (with identity-stabilized elements from useBoard) so editing one
 * element doesn't re-render every other shape — the tldraw perf model.
 */
export const ElementView = memo(function ElementView({
  el,
  interactive,
  selected = false,
  editingId,
  onTransform,
  onEdit,
}: ElementViewProps) {
  const hitTarget = interactive && (el.kind !== "ink" || selected);
  const commitTransform = (e: KonvaEventObject<Event>) => {
    if (!hitTarget) return;
    const node = e.target;
    const sx = node.scaleX();
    const sy = node.scaleY();
    node.scaleX(1);
    node.scaleY(1);
    onTransform(el.id, {
      x: node.x(),
      y: node.y(),
      rotation: node.rotation(),
      w: Math.max(8, Math.round(el.w * sx * 100) / 100),
      h: Math.max(8, Math.round(el.h * sy * 100) / 100),
    });
  };

  return (
    <Group
      id={el.id}
      name="element"
      x={el.x}
      y={el.y}
      rotation={el.rotation}
      opacity={el.opacity}
      listening={hitTarget}
      onTransformEnd={commitTransform}
      onDblClick={() => {
        if (hitTarget && (el.kind === "sticky" || el.kind === "text")) onEdit(el.id);
      }}
    >
      <ElementChildren el={el} editing={editingId === el.id} selected={selected} />
    </Group>
  );
});

function InkStroke({ el }: { el: InkShape }) {
  return (
    <Path
      data={smoothInkPath(el.points)}
      stroke={el.stroke}
      strokeWidth={el.strokeWidth}
      lineCap="round"
      lineJoin="round"
      fillEnabled={false}
      hitStrokeWidth={16}
      perfectDrawEnabled={false}
      shadowForStrokeEnabled={false}
    />
  );
}

function ElementChildren({ el, editing, selected }: { el: BoardElement; editing: boolean; selected: boolean }) {
  switch (el.kind) {
    case "rect": {
      // Border align (Figma): the visible stroke sits outside / centered / inside
      // the original edge — but the hitbox is ALWAYS the original edge (the
      // invisible hit Rect below), so an outer border never extends the grab area.
      const sw = el.strokeWidth > 0 ? el.strokeWidth : 0;
      const inset = el.strokeAlign === "inner" ? sw / 2 : el.strokeAlign === "outer" ? -sw / 2 : 0;
      return (
        <>
          <Rect width={el.w} height={el.h} fill="rgba(0,0,0,0)" />
          <Rect
            x={inset}
            y={inset}
            width={Math.max(1, el.w - inset * 2)}
            height={Math.max(1, el.h - inset * 2)}
            fill={el.fill}
            cornerRadius={6}
            stroke={sw > 0 ? el.stroke : undefined}
            strokeWidth={sw}
            perfectDrawEnabled={false}
            shadowForStrokeEnabled={false}
            listening={false}
          />
        </>
      );
    }

    case "ellipse": {
      const sw = el.strokeWidth > 0 ? el.strokeWidth : 0;
      const inset = el.strokeAlign === "inner" ? sw / 2 : el.strokeAlign === "outer" ? -sw / 2 : 0;
      return (
        <>
          <Ellipse
            x={el.w / 2}
            y={el.h / 2}
            radiusX={Math.max(1, el.w / 2)}
            radiusY={Math.max(1, el.h / 2)}
            fill="rgba(0,0,0,0)"
          />
          <Ellipse
            x={el.w / 2}
            y={el.h / 2}
            radiusX={Math.max(1, el.w / 2 - inset)}
            radiusY={Math.max(1, el.h / 2 - inset)}
            fill={el.fill}
            stroke={sw > 0 ? el.stroke : undefined}
            strokeWidth={sw}
            perfectDrawEnabled={false}
            shadowForStrokeEnabled={false}
            listening={false}
          />
        </>
      );
    }

    case "line":
      return (
        <Line
          points={[0, 0, el.w, el.h]}
          stroke={el.stroke}
          strokeWidth={el.strokeWidth}
          lineCap="round"
          hitStrokeWidth={12}
        />
      );

    case "arrow":
      return (
        <Arrow
          points={[0, 0, el.w, el.h]}
          stroke={el.stroke}
          fill={el.stroke}
          strokeWidth={el.strokeWidth}
          lineCap="round"
          pointerLength={11}
          pointerWidth={9}
          hitStrokeWidth={12}
        />
      );

    case "sticky":
      return (
        <>
          <Rect
            width={el.w}
            height={el.h}
            fill={el.fill}
            cornerRadius={8}
            shadowColor="rgba(0,0,0,0.35)"
            shadowBlur={10}
            shadowOffsetY={3}
            perfectDrawEnabled={false}
            shadowForStrokeEnabled={false}
          />
          {!editing && (
            <Text
              text={el.text || "New note"}
              width={el.w}
              height={el.h}
              padding={12}
              fontSize={15}
              fill={el.text ? "#4a3f1f" : "rgba(74,63,31,0.45)"}
              align="left"
              verticalAlign="top"
              listening={false}
            />
          )}
        </>
      );

    case "ink":
      return (
        <>
          <InkStroke el={el} />
          {selected && (
            // Marquee-selected stroke: dashed bbox outline (screen-space width).
            <Rect
              x={-6}
              y={-6}
              width={el.w + 12}
              height={el.h + 12}
              stroke="#6c8cff"
              strokeWidth={1}
              dash={[4, 3]}
              strokeScaleEnabled={false}
              listening={false}
            />
          )}
        </>
      );

    case "text": {
      // Editing or math-bearing texts render in the DOM overlay; Konva keeps
      // only the invisible interaction box so selection/drag still work.
      const skipKonvaText = editing || hasMath(el.text);
      return (
        <>
          <Rect width={el.w} height={el.h} fill="rgba(0,0,0,0)" />
          {!skipKonvaText && (
            <Text
              text={el.text || "Text"}
              width={el.w}
              height={el.h}
              fontSize={el.fontSize}
              fill={el.text ? el.fill : "rgba(148,163,184,0.5)"}
              fontStyle={el.bold && el.italic ? "bold italic" : el.bold ? "bold" : el.italic ? "italic" : "normal"}
              align={el.align}
              verticalAlign={el.valign}
              listening={false}
            />
          )}
        </>
      );
    }

    case "frame":
      return (
        <>
          <Rect
            width={el.w}
            height={el.h}
            fill={el.fill}
            cornerRadius={8}
            stroke="#3d4354"
            strokeWidth={1}
            dash={[8, 6]}
          />
          <Text
            text={el.name}
            y={-26}
            fontSize={13}
            fill="#8b93a7"
            fontStyle="600"
            listening={false}
          />
        </>
      );

    case "custom":
      return (
        <>
          <Rect
            width={el.w}
            height={el.h}
            fill={el.fill}
            cornerRadius={12}
            stroke={el.stroke}
            strokeWidth={1.5}
            dash={[7, 5]}
          />
          <Text
            text={`✦ ${el.title}`}
            width={el.w}
            y={14}
            padding={12}
            fontSize={15}
            fontStyle="600"
            fill="#c9b8ff"
            align="left"
            listening={false}
          />
          <Text
            text={el.prompt ? el.prompt : "Custom element — generation coming in Slice 5b"}
            width={el.w}
            y={44}
            height={el.h - 58}
            padding={12}
            fontSize={12}
            fill="#8b93a7"
            align="left"
            verticalAlign="top"
            listening={false}
            opacity={0.9}
          />
        </>
      );
  }
}
