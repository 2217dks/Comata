import type { BoardElement, ElementKind } from "./kinds";
import {
  createEllipseElement,
  createFrameElement,
  createRectElement,
  createStickyElement,
  createTextElement,
} from "./kinds";

// ── Kind registry ────────────────────────────────────────────────────────────
// Single source of truth the dock, the properties bar, and the renderer read.
// Adding an element kind = adding a schema + factory (kinds.ts) and one entry
// here — Custom elements (Slice 5b) plug in through this registry.

/** Properties the topbar properties bar exposes for a selected element. */
export type PropKey =
  | "fill"
  | "stroke"
  | "strokeWidth"
  | "strokeAlign"
  | "opacity"
  | "fontSize"
  | "textStyle"
  | "align";

/** How the dock tool places the element on the canvas. */
export type Placement = "click" | "drag" | "stroke";

export type ElementMeta = {
  label: string;
  shortcut: string;
  /** Shown in the tool dock. Custom elements are created by the AI flow, not the dock. */
  tool: boolean;
  placement: Placement;
  /** Transformer may resize/rotate it (ink only moves). */
  resizable: boolean;
  /** Controls the topbar properties bar shows for a selection of this kind. */
  props: PropKey[];
  /** Click-placed kinds only; drag/stroke kinds commit via CRDT calls. */
  create?: (id: string, x: number, y: number, z: number) => BoardElement;
};

export const ELEMENT_REGISTRY: Record<ElementKind, ElementMeta> = {
  rect: {
    label: "Rectangle",
    shortcut: "R",
    tool: true,
    placement: "click",
    resizable: true,
    props: ["fill", "stroke", "strokeWidth", "strokeAlign", "opacity"],
    create: createRectElement,
  },
  ellipse: {
    label: "Ellipse",
    shortcut: "O",
    tool: true,
    placement: "click",
    resizable: true,
    props: ["fill", "stroke", "strokeWidth", "strokeAlign", "opacity"],
    create: createEllipseElement,
  },
  line: {
    label: "Line",
    shortcut: "L",
    tool: true,
    placement: "drag",
    resizable: true,
    props: ["stroke", "strokeWidth", "opacity"],
  },
  arrow: {
    label: "Arrow",
    shortcut: "A",
    tool: true,
    placement: "drag",
    resizable: true,
    props: ["stroke", "strokeWidth", "opacity"],
  },
  sticky: {
    label: "Sticky note",
    shortcut: "S",
    tool: true,
    placement: "click",
    resizable: true,
    props: ["fill", "opacity"],
    create: createStickyElement,
  },
  ink: {
    label: "Ink",
    shortcut: "P",
    tool: true,
    placement: "stroke",
    resizable: false,
    props: ["stroke", "strokeWidth", "opacity"],
  },
  text: {
    label: "Text",
    shortcut: "T",
    tool: true,
    placement: "click",
    resizable: true,
    props: ["fill", "fontSize", "textStyle", "align", "opacity"],
    create: createTextElement,
  },
  frame: {
    label: "Frame",
    shortcut: "F",
    tool: false, // removed from the dock (frames cut); renderer kept for legacy docs
    placement: "click",
    resizable: true,
    props: ["opacity"],
    create: createFrameElement,
  },
  custom: {
    label: "Custom element",
    shortcut: "",
    tool: false, // created by the AI generation flow (Slice 5b)
    placement: "click",
    resizable: true,
    props: ["opacity"],
  },
};
