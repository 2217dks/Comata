import { memo, useRef } from "react";
import type Konva from "konva";
import { Arrow, Ellipse, Group, Line, Path, Rect, Text } from "react-konva";
import type { BoardElement, CodeShape, InkShape } from "@comata/elements";

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
  /** Part of the current (possibly multi-element) selection. */
  selected?: boolean;
  /** This element is being text-edited — its Konva text hides so the
   * DOM textarea is the single source of pixels (no double rendering).
   * A per-element boolean (not a shared id) so the memo only flips for the
   * one edited element, not the whole board. */
  editing?: boolean;
  onEdit: (id: string) => void;
};

/**
 * One Konva Group per element — a pure DISPLAY surface. Band stages are
 * non-interactive: all pointer handling lives in the Board's input stage
 * (manual hit-testing) and resize/rotate drives invisible TransformerProxy
 * nodes there. This component only draws pixels.
 *
 * Memoized (with identity-stabilized elements from useBoard) so editing one
 * element doesn't re-render every other shape — the tldraw perf model.
 */
export const ElementView = memo(function ElementView({
  el,
  selected = false,
  editing = false,
}: ElementViewProps) {
  const groupRef = useRef<Konva.Group | null>(null);

  // Lines/arrows have signed endpoint offsets — normalize the draw box.
  const drawX = Math.min(0, el.w);
  const drawY = Math.min(0, el.h);

  return (
    <Group
      ref={groupRef}
      x={el.x}
      y={el.y}
      rotation={el.rotation}
      opacity={el.opacity}
      listening={false}
    >
      <ElementChildren el={el} editing={editing} selected={selected} />
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
        <>
          {selected && (
            // Selection highlight hugging the stroke (screen-space dash).
            <Line
              points={[0, 0, el.w, el.h]}
              stroke="#6c8cff"
              strokeWidth={1.5}
              dash={[4, 3]}
              strokeScaleEnabled={false}
              listening={false}
            />
          )}
          <Line
            points={[0, 0, el.w, el.h]}
            stroke={el.stroke}
            strokeWidth={el.strokeWidth}
            lineCap="round"
            hitStrokeWidth={12}
          />
        </>
      );

    case "arrow":
      return (
        <>
          {selected && (
            <Line
              points={[0, 0, el.w, el.h]}
              stroke="#6c8cff"
              strokeWidth={1.5}
              dash={[4, 3]}
              strokeScaleEnabled={false}
              listening={false}
            />
          )}
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
        </>
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

    case "code": {
      // Pixels live in the DOM layer (CodeElementEditor, camera-space) —
      // Konva here is only the selection frame + hit region so clicks land
      // on the element. The fill is invisible but must be SOLID on the hit
      // canvas — a ~0 alpha makes Konva's pixel hit-test fail and clicks
      // fall through to elements behind.
      return (
        <Rect
          width={el.w}
          height={el.h}
          fill={selected ? "rgba(0,0,0,0.001)" : "transparent"}
          cornerRadius={10}
          stroke={selected ? "#6c8cff" : "rgba(0,0,0,0.001)"}
          strokeWidth={selected ? 2 : 1}
          hitFunc={(ctx, shape) => {
            ctx.beginPath();
            ctx.rect(0, 0, shape.width(), shape.height());
            ctx.closePath();
            ctx.fillStrokeShape(shape);
          }}
        />
      );
    }

    case "math": {
      // Same overlay contract as code: pixels live in the DOM layer
      // (MathElementEditor, camera-space); Konva draws only the selection
      // frame + hit region. The fill must be SOLID on the hit canvas.
      return (
        <Rect
          width={el.w}
          height={el.h}
          fill={selected ? "rgba(0,0,0,0.001)" : "transparent"}
          cornerRadius={10}
          stroke={selected ? "#6c8cff" : "rgba(0,0,0,0.001)"}
          strokeWidth={selected ? 2 : 1}
          hitFunc={(ctx, shape) => {
            ctx.beginPath();
            ctx.rect(0, 0, shape.width(), shape.height());
            ctx.closePath();
            ctx.fillStrokeShape(shape);
          }}
        />
      );
    }
  }
}
