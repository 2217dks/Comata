# Interaction rules — who captures the pointer, where

> The governing principle (Figma / Excalidraw behavior): **at any moment exactly
> one surface owns the pointer.** Either elements are interactive (Select mode)
> or the whole canvas is the tool surface (any creation tool) — never both.

## The core rule

When a **creation tool** is active, the element layer is non-interactive
(`Layer listening={false}`). Every pointer event lands on the tool surface, so
drawing/placing **over other elements always works** — no hitbox can swallow it.

When **Select (V)** is active, elements are interactive; dragging empty space
draws a **rectangle-select (marquee)**. The camera **never** moves by
click-drag — panning is two-finger scroll, **space-drag**, or **middle-drag**
(pinch = zoom to pointer). The dot grid is part of the canvas: it moves and
scales with the camera.

## The pointer state machine (tldraw model)

Pointer handling is one explicit machine (`board/interactions.ts`) — exactly
one interaction owns the pointer: `idle → pan | marquee | ink | create`. A
**5px screen-space threshold** (tldraw/Excalidraw) separates click from drag
everywhere — no world-space thresholds that break at deep zoom.

- **Esc cancels the in-progress draft** before it deselects (Excalidraw).
- Transformer handles live on their own always-interactive layer — they are
  never swallowed by creation tools, and never start a creation.
- **After committing an element the tool reverts to Select** with the new
  element selected — "done with an element → manipulate it". Pen/highlighter
  stay active (strokes come in bursts).

## Tool matrix

| Tool | Starts over elements? | Gesture | Commit |
|------|----------------------|---------|--------|
| Select (V) | — | **3-state model on elements**: hover does nothing; press + move = drag the **whole selection**; press + release without moving = click-select (collapses a multi-selection to the pressed element; re-click cycles = deep-select). Press on empty canvas = rectangle select **or lasso** (select-tool sub-popup); handles = resize/rotate | — |
| Pen (P) | **yes** | press → stroke → release; a **click with no movement leaves a dot** | commit on mouseup anywhere (even outside the stage) |
| Highlighter (H) | **yes** | same as pen; translucent by default | commit on mouseup |
| Line (L) | **yes** | drag from start to end | commit on mouseup if length > 8px |
| Arrow (A) | **yes** | drag | same as line |
| Shape (R rect / O ellipse) | **yes** | one dock tool (Figma) with a **sub-popup** to switch rectangle/ellipse; drag to size — **stacks over anything** | commit on mouseup |
| Text (T) | **yes — placed over anything** | click places and opens the editor; drag sizes the box | live-syncs per keystroke; blur/Esc ends |
| Sticky (S) | **yes** | click places and opens the editor; drag sizes it — double-click empty canvas in Select mode also drops one | live-syncs; blur/Esc ends |

**Click rule (Figma layering):** creation tools **never select**. Text/sticky
place over any element (text on a box just works); shape/line/arrow revert to
Select on a bare click. Selecting is the Select tool's job — with the 3-state
model above.

**After any creation the tool reverts to Select**, so the resize handles are
immediately draggable (Figma behavior).

Double-click a text/sticky = re-edit.

## Selection & ink

- Selection is **multi** (rectangle select or lasso — switched via the Select
  tool's sub-popup). Marquee selects everything **touching** the rect (edges
  inclusive); lasso selects elements whose bbox corners/center fall inside the
  freehand polygon. Ink is included in both — the only way to select strokes.
- **Group move**: dragging any element of a multi-selection moves the whole
  selection — including presses on the empty gaps **inside the selection's
  bounding box** (the selection background: drag moves, bare click keeps).
  Machine-driven with throttled live sync; the Transformer shows one combined
  box and scales all selected resizable elements together.
- **Hitboxes are shape-aware (Canva-like)**: lines/arrows answer to their
  **stroke** (segment distance + slack), not their bounding rectangle — in
  Konva (`hitStrokeWidth`) and in the machine's hit tests alike.
- **The selection overlay equals the hitbox** — for shapes the Transformer box
  is pinned to the original edge rectangle (an outer border never inflates it);
  lines/arrows have **no rectangular overlay at all**: a dashed stroke
  highlight plus two draggable **endpoint handles** (Canva-style) that reshape
  the element live in any direction (w/h are signed offsets; all bbox math is
  normalized via `bboxOf`).
- **Shape borders** have Figma-style alignment — outer / middle / inner — but
  the hitbox is ALWAYS the original rectangle edge: an outer border never
  extends the grab area (an invisible hit shape enforces it).
- **Ink strokes are click-immune** — clicking a stroke never selects it.
  A marquee/lasso-selected stroke shows a dashed bbox outline and moves with
  the selection.
- ⌫ deletes the whole selection; ⌘D duplicates it; **⌘C/⌘X/⌘V copy, cut, and
  paste** (each successive paste stacks further down-right; pasted elements
  arrive selected); z-order ops apply to a single selection only.
- **History is per-user (Canva behavior)**: ⌘Z / ⌘⇧Z (or ⌘Y) undo and redo
  only ever touch THIS session's changes — collaborators' edits are never
  reverted by your undo. A whole drag is one undo step; typing bursts merge;
  each committed gesture starts a fresh entry.

### Text alignment

Text elements expose horizontal (left/center/right) and vertical
(top/middle/bottom) alignment inside their box — controls in the properties
bar, applied live to the canvas render and the DOM editor.

## Text model (Figma-style, no double rendering)

- New text/sticky elements start **empty**; the word "Text"/"New note" is a
  **placeholder** (rendered gray by Konva, or via `::placeholder` in the DOM
  textarea) — it is never stored content.
- Creation: click to place (default size) or drag to size, then type.
- While editing, the Konva text for that element is hidden — the DOM textarea
  is the **single source of pixels** (transparent box, caret only, no border).
  This is the standard canvas-app hybrid: canvas renders committed content, a
  DOM overlay hosts the live editor.

## Styles: selection first, defaults second (Figma rule)

The topbar properties bar is one panel with two modes:

1. **Something is selected** → edits apply to that element immediately.
2. **A creation tool is active, nothing selected** → edits change that tool's
   **defaults**, which are applied to the next created element (pen color,
   highlighter width, shape fill/border, text color).

Shape borders are independent: fill color, border color, border width
(0 = none), opacity — each settable per element or as defaults.

## Z-order

Never implicit. Moving an element does **not** change its layer. Order changes
only via: right-click menu (Bring forward `]` / Send backward `[` / Bring to
front / Send to back) or the `[` / `]` keys. One-level ops swap z with the
adjacent element in the stack.

## Performance model

- Elements get **identity-stabilized projections** from the CRDT (unchanged
  elements keep their object reference), so `React.memo` on `ElementView`
  skips re-rendering every shape on any edit — the tldraw per-shape model.
- Konva hot-path flags on shapes: `perfectDrawEnabled={false}`,
  `shadowForStrokeEnabled={false}`.
- Dragging an element syncs its position **live** (throttled to 40ms) — peers
  see motion, not jumps. Cursor presence is throttled to 40ms, camera to 60ms.

## Removed: frames

Frames were cut from the dock/shortcuts (user decision — they were filler).
Slice 7 removed the kind entirely (see "Slice 7 rework" below); legacy docs
containing frames fail schema validation and their elements are dropped on
projection (accepted — no migration, owner opted to discard old data).

## Mode gates

- **Present mode** exists only in presentation-kind notebooks (the Board gets
  the notebook kind; canvas notebooks never show the Present button).
- **Read-only (VIEWER)**: no tools, no editing, no present.
- **Follow mode**: click a peer's avatar (or the presenter pill); any manual
  pan/zoom breaks it.

## Slice 7 rework: pages (ADR-0005)

Frames are REMOVED entirely (kind deleted from the union, factory, registry;
renderer case cut). Slice 3's broadcast-present/follow mode is gone with
them — presentation is per-user local.

**Pages** (presentation notebooks only):
- 1920×1080 world units, 16:9. Every element carries `pageId`; the page list
  is a Y.Array of `{id, background}` records. Numbered only — a title is just
  a text element on the page.
- Edit mode: one page fit-to-viewport; zoom/pan allowed inside it. Page
  sidebar (editor chrome): thumbnails, add, duplicate, delete (last page
  protected; page + its elements go in ONE transaction = one undo step),
  drag-reorder, per-page background color.
- Cross-page move: right-click "Move to page ▸ N" — identity-preserving
  (the same element row flips pageId). Copy/paste remains a copy (fresh ids).
- Element default colors derive from the surface's background luminance
  (light → dark ink/text; dark → light). Surface = current page in decks,
  notebook background (light/dark, creation-fixed) in canvas notebooks.

**Present mode** (decks only, per-user local — nothing is broadcast):
- Fullscreen fit of the current page; no zoom/pan; ←/→ + counter; Esc exits.
- Geometry locked (no select/move/resize/create/context menu).
- Pen/highlighter ARE live — the lone editing exception; strokes commit as
  shared elements, visible to everyone in real time.
- Interactive elements are single-click live for EVERYONE (no double-click):
  math graph pans, code runs (viewers still gated by `allowViewerRuns`), AI
  widget iframes engage. Equations stay non-editable for viewers.

**Viewers** get the same page UI read-only: pdf-style sidebar of thumbnails
(clickable, no management buttons), full interactivity of the per-user parts
above.

## Mode gates (updated)

- **Present mode** button only in presentation-kind notebooks; present is
  LOCAL playback (per-user), not a broadcast.
- **Read-only (VIEWER)**: no tools, no editing, no geometry changes; present
  navigation + interactive elements work (run gate applies).
- **Follow mode: REMOVED** (ADR-0005) — avatars show who's on the board,
  nothing more.
