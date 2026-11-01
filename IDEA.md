# Comata

**An infinite canvas + presentation tool for teaching, where code runs, math comes alive, and everything is just another element on the board.**

Think of it as **Canva Whiteboard × LeetCode × Desmos × Excalidraw × OneNote**, fused into one collaborative teaching surface.

---

## 1. The Problem

Every person who teaches STEM (or learns STEM) is forced to juggle 4–6 disconnected tools:

| Tool | What it does well | What it can't do |
|---|---|---|
| **Excalidraw / tldraw** | Freeform sketching, diagrams, hand-drawn feel | No runnable code, no math plotting, weak presentation mode |
| **Canva Whiteboard** | Beautiful elements, drag-and-drop, presentation slides | No code execution, no math, drawing is second-class |
| **VS Code / LeetCode** | Write + run code in many languages | Zero visual/teaching context; code lives in a vacuum |
| **Desmos / GeoGebra** | Gorgeous interactive 2D/3D math | Can't be embedded in a lesson, no drawing around it, no code |
| **OneNote / Notability** | Write notes on top of PDFs/images | No code, no graphs, no real collaboration, proprietary lock-in |
| **Google Slides / PowerPoint** | Presentation structure | Static. Dead content. Screenshots of Desmos and code |

The teacher's workflow today is: prepare slides → screenshot Desmos → paste code screenshots → switch to browser to "live demo" the code → switch back → lose the class's attention. **Context switching is the enemy of teaching.**

## 2. The Core Idea

When you create a new project in the app, you first choose **how the document is structured** — exactly like Canva's "Create a design" flow:

| Document kind | Behavior |
|---|---|
| **🧾 Infinite Canvas** | One boundless board. Pan/zoom freely, elements anywhere, presentation via *frames* (camera jumps to regions). Best for live teaching, brainstorming, explanations. |
| **🎞️ Presentation** | Fixed-size pages (1920×1080-like slide grid), ordered, one slide at a time in edit and present mode. Elements still float freely *within* a slide. Best for structured lectures and deliverables. |

Both kinds share the **exact same element system** — a code block, ink stroke, or graph behaves identically in either. The only difference is the coordinate space (infinite plane vs. stacked fixed pages) and the navigation model.

On that surface, **every piece of teaching material is a first-class, floating, movable, resizable element**:

- ✏️ **Freehand ink** — stylus/finger/mouse drawing and handwriting anywhere, on top of anything
- 📦 **Code blocks** — select a language (like LeetCode), type code, provide stdin, get live stdout — the block stays pinned on the canvas where you left it
- 📈 **Math graph elements** — 2D/3D interactive plots, in-canvas, movable like any other element
- 📝 **Text boxes, shapes, arrows, sticky notes** — the usual whiteboard staples
- 🖼️ **Imports** — images, PDFs, **DOCX**, **PPTX** — like OneNote, write/annotate on top of them
- 👥 **Real-time collaboration** — Figma-style: multiple users on the same board, permission tiers (viewer / commenter / editor / owner)

And underneath it all, a **virtual file system** so boards, assets, and imports are organized like files — the tool becomes a *workspace*, not a scratchpad.

### The One-Sentence Pitch

> *"A collaborative infinite canvas where every element — drawing, code block, or graph — is live, executable, and interactive."*

## 3. The Element System (Heart of the Design)

Everything on the canvas is an **element** with the same universal behavior:

Each element can be: **dragged, resized, rotated, layered, grouped, locked, duplicated, deleted** — exactly like Canva. The magic is in what the *payload* holds:

### 3.1 Ink / Drawing Element
- Brush types: pen, highlighter, eraser
- **Handwriting stays as ink** (vector) — optionally recognized to text later (stretch goal)
- Renders *above* or *below* other elements based on z-index — so you can draw an arrow pointing at a code block's bug, or annotate a graph

### 3.2 Code Element (the LeetCode-in-a-box)
- Language selector: JavaScript/TypeScript, Python, C, C++, Java, Rust, Go… (driven by whatever the execution backend supports)
- Editor pane (embedded Monaco/CodeMirror instance, syntax highlighted, tab-completion)
- Optional **stdin input box** (like LeetCode's custom input)
- **Output pane**: stdout, stderr, exit code, execution time
- **Run button** — executes on the server (never in the browser for compiled/unsafe langs), streams output back
- The whole thing — editor + stdin + output — is one draggable element. Resize it and the panes reflow.
- **The code lives as a real file in the VFS** (§5): a Python code element is backed by a `main.py` in the board's VFS; a C++ one by `main.cpp`, Java by `Main.java`, etc. The on-canvas editor *is* that file. Editing the file in the VFS panel updates the on-canvas block, and vice versa — one source of truth.
- Persistent: the code file, language, stdin, and last output are all saved with the board. Reopen next week, hit Run again, it still works — and you can copy `main.py` out of the VFS to download it.

### 3.3 Math Graph Element (the Desmos-in-a-box)
- **2D mode**: plot `y = f(x)`, parametric curves, points, inequalities; pan/zoom/drag like Desmos
- **3D mode**: surface plots `z = f(x, y)`, rotate with mouse
- Expression input with live re-plot on keystroke
- Sliders for parameters (a, b, k) that animate the graph — the thing that makes Desmos magical for teaching
- Fully interactive *while* other elements sit next to it and ink sits on top of it

### 3.4 Text Element
- Rich-ish text (bold/italic/size/color, maybe basic markdown)
- Inline LaTeX for math notation (rendered, e.g. KaTeX)

### 3.5 Shape Element
- Rectangle, ellipse, arrow, line, diamond, sticky note — the Excalidraw set

### 3.6 Media Element (image / PDF / DOCX / PPTX)
- Image: place, scale, annotate on top with ink
- **PDF**: import a PDF, each page becomes a Element or canvas surface or Background like canva — write on the lecture slides, solve the past-paper, mark up the question paper. This is the OneNote killer feature, and it's genuinely feasible.
- **DOCX (possibility)**
- **PPTX (possibility)**

### 3.7 The Slide vs. Canvas Paradigms (§2's two document kinds, in practice)
- **Infinite canvas doc**: everything is placed on one endless plane. Optional *Frame elements* define "camera stops" for presenting — draw annotations in the margin around a frame, visible while editing, hidden while presenting (Excalidraw-style).
- **Presentation doc**: fixed 16:9 pages, ordered, page-flip navigation. Same element system; a slide is just a page container with the same x/y coordinate space, one page visible at a time.
- **Creating a document**: the "New" dialog asks *Infinite Canvas* or *Presentation* (like Canva's template picker) — the doc kind is stored on the board row and drives the frontend editor mode. (Stretch: "Move elements to slides" conversion between kinds — ambitious, defer it.)
- later on other possible Kind of Notebooks could be provided. the document could be pre themed or follow a user's selected theme, like if 2 person working on same page, the content is same but the whole style is different for both of them (Font, Color Theme, Light/Dark Mode, Customisations, Etc)

## 4. Collaboration

- **Real-time multiplayer**: every participant's cursor shows name + color (Figma-style). Element moves/edits.
- **CRDT-based state sync**: this is the modern, correct answer to "how do two people edit the same canvas without conflicts." It handles concurrent element moves, ink strokes, and text edits automatically.
- **Permission tiers**:
  - **Owner**: full control, share links, manage access
  - **Editor**: edit everything
  - **Commenter**: draw temporary ink + sticky comments only (their strokes render in their color layer)
  - **Viewer**: read-only, follow presenter's viewport
- **Follow mode**: viewer's viewport locks onto the presenter's camera — critical for teaching.
- Present mode + collaboration together = the teacher presents while students follow, and a student can be granted editor access mid-class to "come solve this on the board."